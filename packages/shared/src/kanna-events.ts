/**
 * KannaEvent — the single WebSocket bus event union consumed by the UI
 * (ADR-009). The backend publishes these on ws://<ingestHost>:<ingestPort>/ui.
 */
import type { AuditEvent, BrowserAction, Finding, Observation, TrafficFlow } from "./types.js";
import type { AgentContextStatus } from "./agent-runtime-contract.js";

export type AgentToolProfile = "chat" | "read-only" | "workspace" | "full";
export type AgentWorkspaceStatus = "idle" | "running" | "stopped" | "error";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface Project {
  id: string;
  name: string;
  description?: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectAsset {
  id: string;
  projectId: string;
  type: "url" | "file" | "directory" | "text";
  name: string;
  value: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AgentWorkspace {
  id: string;
  projectId: string;
  name: string;
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  systemPrompt: string;
  toolProfile: AgentToolProfile;
  piSessionFile?: string;
  status: AgentWorkspaceStatus;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
}

/** A durable conversation owned by an Agent and bound to one local workspace. */
export interface AgentChatSession {
  id: string;
  agentId: string;
  name: string;
  workspacePath: string;
  piSessionFile?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSkillCapability {
  id: string;
  agentId: string;
  path: string;
  names: string[];
  descriptions: string[];
  enabled: boolean;
  createdAt: number;
}

export interface AgentPluginCapability {
  id: string;
  agentId: string;
  name: string;
  path: string;
  enabled: boolean;
  createdAt: number;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface AgentMcpServer {
  id: string;
  agentId: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  envKeys: string[];
  enabled: boolean;
  toolNames: string[];
  lastError?: string;
  lastCheckedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentCapabilities {
  skills: AgentSkillCapability[];
  mcpServers: AgentMcpServer[];
  plugins: AgentPluginCapability[];
}

export interface AgentAttachment {
  id: string;
  agentId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
}

export type SshAuthType = "password" | "private-key";
export type SshConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface SshHost {
  id: string;
  projectId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  privateKeyPath?: string;
  hostFingerprint?: string;
  status: SshConnectionStatus;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SshCommandResult {
  id: string;
  hostId: string;
  actor: "user" | "agent";
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  startedAt: number;
  endedAt: number;
}

export interface SubagentActivity {
  id: string;
  agent: string;
  task: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped" | "skipped";
  model: string;
  toolProfile: AgentToolProfile;
  text: string;
  toolCount: number;
  lastTool?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  transcript: Array<{ role: "assistant" | "tool"; text: string; toolName?: string; isError?: boolean }>;
}

export interface AgentChatMessage {
  role: "user" | "assistant" | "tool" | "system" | "custom";
  text: string;
  toolName?: string;
  toolCallId?: string;
  subagents?: SubagentActivity[];
  isError?: boolean;
  timestamp?: number;
  attachments?: AgentAttachment[];
}

export type AttackGraphStatus = "running" | "summarizing" | "completed" | "stopped" | "error";
export type AttackGraphNodeKind = "objective" | "analysis" | "action" | "discovery" | "decision" | "outcome";

export interface AttackGraphNode {
  id: string;
  kind: AttackGraphNodeKind;
  title: string;
  detail?: string;
  status: AttackGraphStatus;
  timestamp: number;
  toolCallId?: string;
}

export interface AttackGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

/** The latest Agent execution rendered as a durable, event-derived flow graph. */
export interface AttackGraph {
  agentId: string;
  sessionId?: string;
  runId: string;
  status: AttackGraphStatus;
  startedAt: number;
  completedAt?: number;
  nodes: AttackGraphNode[];
  edges: AttackGraphEdge[];
}

/** List-row projection of a TrafficFlow — no headers, no bodies (token/size budget). */
export interface TrafficFlowSummary {
  id: string;
  timestampStart: number;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode?: number;
  contentType?: string;
  source: TrafficFlow["source"];
  browserActionId?: string;
  requestSize?: number;
  responseSize?: number;
  totalMs?: number;
  interceptStatus?: "pending" | "dropped";
}

/** A persisted capture session projected for the Traffic workspace. */
export interface TrafficCaptureSession {
  id: string;
  target?: string;
  startedAt: number;
  endedAt?: number;
  flowCount: number;
  actionCount: number;
  demo?: boolean;
}

/** Bounded flow detail used by the Traffic inspector and Agent context bridge. */
export interface TrafficFlowDetail {
  flow: TrafficFlow;
  requestBodyText?: string;
  responseBodyText?: string;
  truncated: boolean;
  action?: BrowserAction;
}

export interface TrafficCaptureStatus {
  state: "stopped" | "starting" | "listening" | "error";
  listenHost: "127.0.0.1";
  listenPort: number;
  interceptEnabled: boolean;
  sessionId?: string;
  lastError?: string;
  mitmAvailable: boolean;
}

export function toFlowSummary(flow: TrafficFlow): TrafficFlowSummary {
  return {
    id: flow.id,
    timestampStart: flow.timestampStart,
    method: flow.method,
    url: flow.url,
    host: flow.host,
    path: flow.path,
    statusCode: flow.statusCode,
    contentType: flow.contentType,
    source: flow.source,
    browserActionId: flow.browserActionId,
    requestSize: flow.requestBody?.size,
    responseSize: flow.responseBody?.size,
    totalMs: flow.timing.totalMs,
    interceptStatus: flow.securityMetadata.passiveFlags?.includes("intercept-pending")
      ? "pending"
      : flow.securityMetadata.passiveFlags?.includes("intercept-dropped")
        ? "dropped"
        : undefined,
  };
}

export type RunStatus = "starting" | "running" | "idle" | "ended" | "error";

export type KannaEvent =
  | { type: "run"; status: RunStatus; sessionId: string; detail?: string }
  | { type: "action"; action: BrowserAction }
  | { type: "flow"; flow: TrafficFlowSummary }
  | { type: "flow_update"; flow: TrafficFlowSummary }
  | { type: "observation"; observation: Observation }
  | { type: "finding"; finding: Finding }
  | { type: "audit"; event: AuditEvent }
  | { type: "project"; project: Project }
  | { type: "project_deleted"; projectId: string }
  | { type: "asset"; asset: ProjectAsset }
  | { type: "agent_status"; agent: AgentWorkspace }
  | { type: "agent_context"; agentId: string; sessionId: string; context: AgentContextStatus }
  | { type: "agent_chat_run"; agentId: string; sessionId: string; status: AgentWorkspaceStatus; at: number; detail?: string }
  | { type: "agent_deleted"; agentId: string }
  | { type: "chat_session_updated"; session: AgentChatSession }
  | { type: "chat_session_deleted"; agentId: string; sessionId: string }
  | { type: "agent_delta"; agentId: string; sessionId?: string; delta: string }
  | { type: "agent_message"; agentId: string; sessionId?: string; message: AgentChatMessage }
  | {
      type: "agent_tool";
      agentId: string;
      sessionId?: string;
      phase: "start" | "end";
      toolCallId: string;
      toolName: string;
      isError?: boolean;
      detail?: string;
      subagents?: SubagentActivity[];
    }
  | { type: "agent_queue"; agentId: string; sessionId?: string; steering: string[]; followUp: string[] }
  | { type: "agent_graph"; graph: AttackGraph }
  | { type: "ssh_host"; host: SshHost }
  | { type: "ssh_command"; projectId: string; result: SshCommandResult }
  /** Passthrough of Pi AgentEvent (message_update deltas etc.) — opaque to the bus. */
  | { type: "agent"; event: unknown }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; detail?: unknown };
