import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type CreateAgentSessionResult,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { KannaEvent, ThinkingLevel } from "@kanna/shared";

export interface KannaAgentConfig {
  cwd: string;
  agentDir: string;
  modelsPath: string;
  authPath: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  apiKey: string;
  tools: ToolDefinition[];
  systemPrompt?: string;
  sessionManager?: SessionManager;
  sessionDir?: string;
  resume?: boolean;
  sessionPath?: string;
  emit?: (event: KannaEvent) => void;
}

export interface KannaAgentSession extends CreateAgentSessionResult {
  modelRuntime: ModelRuntime;
  waitUntilIdle(timeoutMs?: number): Promise<void>;
  dispose(): void;
}

export async function createKannaAgentSession(config: KannaAgentConfig): Promise<KannaAgentSession> {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: config.modelsPath,
    authPath: config.authPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey(config.providerId, config.apiKey);
  const model = modelRuntime.getModel(config.providerId, config.modelId);
  if (!model) throw new Error(`Configured model not found: ${config.providerId}/${config.modelId}`);
  const systemPrompt =
    config.systemPrompt ??
    (await readFile(fileURLToPath(new URL("../prompts/system.md", import.meta.url)), "utf8"));
  const loader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: config.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  const result = await createAgentSession({
    modelRuntime,
    model,
    thinkingLevel: config.thinkingLevel,
    noTools: "builtin",
    customTools: config.tools,
    sessionManager:
      config.sessionManager ??
      (config.sessionPath
        ? SessionManager.open(config.sessionPath, config.sessionDir, config.cwd)
        : config.resume
          ? SessionManager.continueRecent(config.cwd, config.sessionDir)
          : SessionManager.create(config.cwd, config.sessionDir)),
    resourceLoader: loader,
  });
  const unsubscribe = config.emit
    ? result.session.subscribe((event) => config.emit?.({ type: "agent", event }))
    : undefined;
  return {
    ...result,
    modelRuntime,
    async waitUntilIdle(timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (!result.session.isIdle && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (!result.session.isIdle) throw new Error(`Agent did not become idle within ${timeoutMs}ms`);
    },
    dispose() {
      unsubscribe?.();
      result.session.dispose();
    },
  };
}
