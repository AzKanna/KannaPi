import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type CreateAgentSessionResult,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentAttachment,
  AgentChatMessage,
  AgentToolProfile,
  AgentRuntimeSettings,
  ThinkingLevel,
} from "@kanna/shared";
import { type ConnectedMcpServer, connectMcpServer, type McpConnectionConfig } from "./capabilities.js";
import { createSandboxTools, type WindowsSandbox } from "./sandbox.js";
import { createBenchTools, type BenchAgentPort } from "./bench-tool.js";
import { createWebSearchTool, type WebSearchPort } from "./web-search-tool.js";
import { createSubagentTool, subagentsFromResult } from "./subagent-tool.js";

export const TOOL_PROFILES: Record<AgentToolProfile, string[]> = {
  chat: [],
  "read-only": ["read", "grep", "find", "ls"],
  workspace: ["read", "grep", "find", "ls", "edit", "write"],
  full: ["read", "grep", "find", "ls", "edit", "write", process.platform === "win32" ? "powershell" : "bash"],
};

export interface GeneralAgentConfig {
  cwd: string;
  agentDir: string;
  modelsPath: string;
  authPath: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  sandbox?: WindowsSandbox;
  /** Subsessions borrow the parent's sandbox; only its owner releases it. */
  ownsSandbox?: boolean;
  subagents?: AgentRuntimeSettings["multiAgent"];
  compaction?: AgentRuntimeSettings["compaction"];
  apiKey?: string;
  toolProfile?: AgentToolProfile;
  systemPrompt?: string;
  sessionDir: string;
  sessionPath?: string;
  persistence?: "disk" | "memory";
  onEvent?: (event: unknown) => void;
  skillPaths?: string[];
  pluginPaths?: string[];
  mcpServers?: McpConnectionConfig[];
  customTools?: ToolDefinition[];
  /** Explicit read-only API broker; never opens arbitrary host tools in sandbox mode. */
  webSearch?: WebSearchPort;
  /** Explicit Bench broker; scoped to one challenge and injected only for benchmark runs. */
  benchmark?: BenchAgentPort;
  onMcpStatus?: (status: { id?: string; name: string; toolNames: string[]; error?: string }) => void;
}

export interface GeneralAgentSession extends CreateAgentSessionResult {
  modelRuntime: ModelRuntime;
  toolProfile: AgentToolProfile;
  sandbox?: WindowsSandbox;
  loadedSkills: string[];
  mcpToolNames: string[];
  mcpErrors: Array<{ id?: string; name: string; error: string }>;
  dispose(): Promise<void>;
}

export async function createGeneralAgentSession(config: GeneralAgentConfig): Promise<GeneralAgentSession> {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: config.modelsPath,
    authPath: config.authPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  if (config.apiKey) await modelRuntime.setRuntimeApiKey(config.providerId, config.apiKey);
  const model = modelRuntime.getModel(config.providerId, config.modelId);
  if (!model) throw new Error(`Configured model not found: ${config.providerId}/${config.modelId}`);

  const systemPrompt =
    config.systemPrompt?.trim() ||
    (await readFile(fileURLToPath(new URL("../prompts/general.md", import.meta.url)), "utf8"));
  if (config.sandbox && config.skillPaths?.length) await config.sandbox.initialize();
  const toolProfile = config.toolProfile ?? "read-only";
  const pluginPaths = !config.sandbox && toolProfile === "full" ? (config.pluginPaths ?? []) : [];
  const loader = new DefaultResourceLoader({
    cwd: config.sandbox?.workspace ?? config.cwd,
    agentDir: config.agentDir,
    noExtensions: true,
    additionalExtensionPaths: pluginPaths,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: Boolean(config.sandbox),
    systemPrompt,
    noSkills: true,
    additionalSkillPaths: config.sandbox ? config.sandbox.skillPaths : (config.skillPaths ?? []),
  });
  await loader.reload();
  const loadedExtensions = loader.getExtensions();
  if (loadedExtensions.errors.length)
    throw new Error(`Pi Plugin failed to load: ${loadedExtensions.errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
  const pluginToolNames = loadedExtensions.extensions.flatMap((extension) => [...extension.tools.keys()]);
  const sandboxTools = config.sandbox ? createSandboxTools(config.sandbox, toolProfile) : [];
  const selectedTools = config.sandbox
    ? sandboxTools.map((tool) => tool.name)
    : [...TOOL_PROFILES[toolProfile]];
  const mcpConnections: ConnectedMcpServer[] = [];
  const mcpErrors: Array<{ id?: string; name: string; error: string }> = [];
  for (const server of config.sandbox ? [] : (config.mcpServers ?? [])) {
    try {
      mcpConnections.push(await connectMcpServer({ ...server, cwd: server.cwd ?? config.cwd }));
      const connection = mcpConnections.at(-1);
      config.onMcpStatus?.({ id: server.id, name: server.name, toolNames: connection?.toolNames ?? [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mcpErrors.push({ id: server.id, name: server.name, error: message });
      config.onMcpStatus?.({ id: server.id, name: server.name, toolNames: [], error: message });
    }
  }
  const mcpTools = mcpConnections.flatMap((connection) => connection.tools);
  const mcpToolNames = mcpTools.map((tool) => tool.name);
  const customTools = config.sandbox ? sandboxTools : [...(config.customTools ?? []), ...mcpTools];
  if (config.webSearch && toolProfile !== "chat") {
    if (customTools.some((tool) => tool.name === "web_search"))
      throw new Error("web_search is reserved for the trusted search broker");
    customTools.push(createWebSearchTool(config.webSearch));
  }
  if (config.benchmark) {
    if (customTools.some((tool) => tool.name === "bench_submit_flag" || tool.name === "bench_get_hint"))
      throw new Error("bench_* tools are reserved for the trusted benchmark broker");
    customTools.push(...createBenchTools(config.benchmark));
  }
  if (config.subagents?.enabled && toolProfile !== "chat") {
    if (customTools.some((tool) => tool.name === "subagent")) throw new Error("subagent is reserved for Pi delegation");
    customTools.push(createSubagentTool((preset, profile, onEvent) => createGeneralAgentSession({
      ...config,
      cwd: config.sandbox?.workspace ?? config.cwd,
      toolProfile: profile,
      systemPrompt: `${systemPrompt}\n\n${preset.prompt}\nYou are an independent ${preset.name} subagent. Perform only the delegated task. You cannot delegate further.`,
      subagents: undefined,
      ownsSandbox: false,
      persistence: "memory",
      sessionPath: undefined,
      onEvent,
      // Child tools are deliberately selected by the role and parent permission ceiling.
      customTools: [],
      mcpServers: [],
      pluginPaths: [],
      onMcpStatus: undefined,
      benchmark: undefined,
    }), { parentProfile: toolProfile, maxConcurrency: config.subagents.maxConcurrency,
      timeoutMs: config.subagents.timeoutMinutes * 60000, model: `${config.providerId}/${config.modelId}` }));
  }
  selectedTools.push(...customTools.map((tool) => tool.name));
  for (const name of pluginToolNames) {
    if (selectedTools.includes(name)) throw new Error(`Pi Plugin tool conflicts with an existing tool: ${name}`);
    selectedTools.push(name);
  }
  const compaction = config.compaction;
  const reserveTokens = compaction
    ? Math.max(512, Math.floor(model.contextWindow * (1 - compaction.thresholdPercent / 100)))
    : 16384;
  const settingsManager = SettingsManager.inMemory({
    compaction: compaction
      ? {
          enabled: compaction.enabled,
          reserveTokens,
          keepRecentTokens: Math.min(
            compaction.keepRecentTokens,
            Math.max(256, Math.floor((model.contextWindow - reserveTokens) / 2)),
          ),
        }
      : { enabled: true },
  });
  const result = await createAgentSession({
    cwd: config.sandbox?.workspace ?? config.cwd,
    agentDir: config.agentDir,
    modelRuntime,
    model,
    thinkingLevel: config.thinkingLevel,
    settingsManager,
    ...(selectedTools.length ? { tools: selectedTools } : { noTools: "all" as const }),
    customTools,
    sessionManager:
      config.persistence === "memory"
        ? SessionManager.inMemory(config.cwd)
        : config.sessionPath
          ? SessionManager.open(config.sessionPath, config.sessionDir, config.cwd)
          : SessionManager.create(config.cwd, config.sessionDir),
    resourceLoader: loader,
  });
  const unsubscribe = config.onEvent ? result.session.subscribe(config.onEvent) : undefined;
  return {
    ...result,
    modelRuntime,
    toolProfile,
    sandbox: config.sandbox,
    loadedSkills: loader.getSkills().skills.map((skill) => skill.name),
    mcpToolNames,
    mcpErrors,
    async dispose() {
      unsubscribe?.();
      result.session.dispose();
      if (config.ownsSandbox !== false) await config.sandbox?.dispose();
      await Promise.all(mcpConnections.map((connection) => connection.close().catch(() => undefined)));
    },
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return [value.text];
      if (value.type === "toolResult" && typeof value.content === "string") return [value.content];
      return [];
    })
    .join("\n");
}

export const ATTACHMENT_CONTEXT_START = "<kanna-attachment-context>";
export const ATTACHMENT_CONTEXT_END = "</kanna-attachment-context>";

function displayMessage(text: string): { text: string; attachments?: AgentAttachment[] } {
  const marker = text.indexOf(ATTACHMENT_CONTEXT_START);
  if (marker < 0) return { text };
  const end = text.indexOf(ATTACHMENT_CONTEXT_END, marker);
  let attachments: AgentAttachment[] | undefined;
  if (end > marker) {
    try {
      const parsed = JSON.parse(text.slice(marker + ATTACHMENT_CONTEXT_START.length, end).trim()) as {
        attachments?: Array<Record<string, unknown>>;
      };
      attachments = parsed.attachments?.flatMap((item) => {
        if (!item?.id || !item.name) return [];
        return [
          {
            id: String(item.id),
            agentId: String(item.agentId ?? ""),
            name: String(item.name),
            mimeType: String(item.mimeType ?? "application/octet-stream"),
            size: Number(item.size ?? 0),
            createdAt: Number(item.createdAt ?? 0),
          },
        ];
      });
    } catch {
      attachments = undefined;
    }
  }
  return { text: text.slice(0, marker).trim(), attachments };
}

export function normalizeAgentMessage(message: unknown): AgentChatMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as Record<string, unknown>;
  const rawRole = typeof value.role === "string" ? value.role : "custom";
  const role = rawRole === "toolResult" ? "tool" : rawRole;
  if (!["user", "assistant", "tool", "system", "custom"].includes(role)) return undefined;
  const normalized = displayMessage(textFromContent(value.content));
  if (!normalized.text && role !== "tool" && !normalized.attachments?.length) return undefined;
  return {
    role: role as AgentChatMessage["role"],
    text: normalized.text,
    attachments: normalized.attachments,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    subagents: subagentsFromResult(value),
    isError: (value.details as { failed?: boolean } | undefined)?.failed === true ? true : typeof value.isError === "boolean" ? value.isError : undefined,
    timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
  };
}
