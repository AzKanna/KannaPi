import { resolve } from "node:path";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool as McpTool,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  defineTool,
  loadSkills,
  type AgentToolResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface McpConnectionConfig {
  id?: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ConnectedMcpServer {
  tools: ToolDefinition[];
  toolNames: string[];
  close(): Promise<void>;
}

export interface SkillInspection {
  path: string;
  names: string[];
  descriptions: string[];
  diagnostics: string[];
}

function safeSegment(value: string, fallback: string, maxLength = 24): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (segment || fallback).slice(0, maxLength);
}

function textFromMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") return [value.text];
    if (value.type === "resource_link") return [JSON.stringify(value)];
    if (value.type === "resource") return [JSON.stringify(value.resource ?? value)];
    if (value.type === "audio") return ["[MCP returned audio content]"];
    return [];
  }).join("\n");
}

function toolResult(result: unknown): AgentToolResult<Record<string, unknown>> {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const text = textFromMcpContent(value.content);
  if (value.isError) throw new Error(text || "MCP tool returned an error");
  const content: AgentToolResult<unknown>["content"] = [];
  if (Array.isArray(value.content)) for (const block of value.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string")
      content.push({ type: "text", text: item.text });
    else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
  }
  if (!content.length)
    content.push({ type: "text" as const, text: value.structuredContent === undefined
      ? "MCP tool completed without text output"
      : JSON.stringify(value.structuredContent) });
  return { content, details: value };
}

function makePiTool(client: Client, serverName: string, tool: McpTool): ToolDefinition {
  const name = `mcp__${safeSegment(serverName, "server")}__${safeSegment(tool.name, "tool", 28)}`;
  const definition: ToolDefinition = {
    name,
    label: `${serverName}: ${tool.name}`,
    description: tool.description || `Run the ${tool.name} tool from the ${serverName} MCP server.`,
    promptSnippet: `${name}: ${tool.description || tool.name}`,
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as ToolDefinition["parameters"],
    async execute(_toolCallId, params, signal) {
      const result = await client.callTool(
        { name: tool.name, arguments: params as Record<string, unknown> },
        signal ? { signal, toolDefinition: tool } : { toolDefinition: tool },
      );
      return toolResult(result);
    },
  };
  return defineTool(definition);
}

export async function connectMcpServer(config: McpConnectionConfig): Promise<ConnectedMcpServer> {
  const client = new Client({ name: "kannapi", version: "0.1.0" });
  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  if (config.transport === "stdio") {
    const command = config.command?.trim();
    if (!command) throw new Error("MCP stdio command is required");
    transport = new StdioClientTransport({
      command,
      args: config.args ?? [],
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "pipe",
    });
  } else {
    if (!config.url?.trim()) throw new Error("MCP HTTP URL is required");
    const url = new URL(config.url);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("MCP URL must use HTTP or HTTPS");
    transport = config.transport === "sse"
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url);
  }
  try {
    await client.connect(transport, { signal: AbortSignal.timeout(15_000) });
    const listed = await client.listTools(undefined, { signal: AbortSignal.timeout(15_000) });
    const used = new Set<string>();
    const tools = listed.tools.flatMap((tool) => {
      const converted = makePiTool(client, config.name, tool);
      if (used.has(converted.name)) return [];
      used.add(converted.name);
      return [converted];
    });
    return { tools, toolNames: tools.map((tool) => tool.name), close: () => client.close() };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export function inspectSkillPath(input: {
  path: string;
  cwd: string;
  agentDir: string;
}): SkillInspection {
  const path = resolve(input.cwd, input.path.trim());
  const result = loadSkills({ cwd: input.cwd, agentDir: input.agentDir, skillPaths: [path], includeDefaults: false });
  if (!result.skills.length) {
    const detail = result.diagnostics.map((diagnostic) => "message" in diagnostic ? String(diagnostic.message) : JSON.stringify(diagnostic)).join("; ");
    throw new Error(detail ? `No valid Skill found: ${detail}` : "No valid SKILL.md found at this path");
  }
  return {
    path,
    names: result.skills.map((skill) => skill.name),
    descriptions: result.skills.map((skill) => skill.description),
    diagnostics: result.diagnostics.map((diagnostic) => "message" in diagnostic ? String(diagnostic.message) : JSON.stringify(diagnostic)),
  };
}
