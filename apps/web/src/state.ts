import type {
  AgentChatMessage,
  AgentContextStatus,
  AgentWorkspaceStatus,
  AgentWorkspace,
  AttackGraph,
  KannaEvent,
  Project,
  ProjectAsset,
  SubagentActivity,
} from "@kanna/shared";

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  phase: "start" | "end";
  isError?: boolean;
  detail?: string;
  subagents?: SubagentActivity[];
  startedAt: number;
  endedAt?: number;
}

export interface ChatRunActivity {
  status: AgentWorkspaceStatus;
  startedAt: number;
  endedAt?: number;
  detail?: string;
}

export interface WorkspaceState {
  connection: "connecting" | "connected" | "disconnected";
  projects: Project[];
  assets: ProjectAsset[];
  agents: AgentWorkspace[];
  messages: Record<string, AgentChatMessage[]>;
  streaming: Record<string, string>;
  tools: Record<string, ToolActivity[]>;
  runs: Record<string, ChatRunActivity>;
  queues: Record<string, { steering: string[]; followUp: string[] }>;
  graphs: Record<string, AttackGraph | undefined>;
  contexts: Record<string, AgentContextStatus>;
}

export const initialState: WorkspaceState = {
  connection: "connecting",
  projects: [],
  assets: [],
  agents: [],
  messages: {},
  streaming: {},
  tools: {},
  runs: {},
  queues: {},
  graphs: {},
  contexts: {},
};

const upsert = <T extends { id: string }>(rows: T[], value: T): T[] => [
  value,
  ...rows.filter((row) => row.id !== value.id),
];

function sameMessage(left: AgentChatMessage | undefined, right: AgentChatMessage): boolean {
  if (!left || left.role !== right.role || left.text !== right.text) return false;
  const leftIds = left.attachments?.map((item) => item.id) ?? [];
  const rightIds = right.attachments?.map((item) => item.id) ?? [];
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

export type WorkspaceAction =
  | KannaEvent
  | { type: "connection"; value: WorkspaceState["connection"] }
  | { type: "hydrate_projects"; projects: Project[] }
  | { type: "hydrate_project"; assets: ProjectAsset[]; agents: AgentWorkspace[] }
  | { type: "hydrate_messages"; agentId: string; messages: AgentChatMessage[] }
  | { type: "hydrate_graph"; agentId: string; graph?: AttackGraph };

export function reduceEvent(state: WorkspaceState, event: WorkspaceAction): WorkspaceState {
  switch (event.type) {
    case "agent_context":
      return { ...state, contexts: { ...state.contexts, [event.sessionId]: event.context } };
    case "connection":
      return { ...state, connection: event.value };
    case "hydrate_projects":
      return { ...state, projects: event.projects };
    case "hydrate_project":
      return { ...state, assets: event.assets, agents: event.agents };
    case "hydrate_messages":
      return { ...state, messages: { ...state.messages, [event.agentId]: event.messages } };
    case "hydrate_graph":
      return { ...state, graphs: { ...state.graphs, [event.agentId]: event.graph } };
    case "project":
      return { ...state, projects: upsert(state.projects, event.project) };
    case "project_deleted":
      return { ...state, projects: state.projects.filter((item) => item.id !== event.projectId), agents: state.agents.filter((item) => item.projectId !== event.projectId) };
    case "asset":
      return { ...state, assets: upsert(state.assets, event.asset) };
    case "agent_status":
      return { ...state, agents: upsert(state.agents, event.agent) };
    case "agent_chat_run": {
      const previous = state.runs[event.sessionId];
      const started = event.status === "running";
      return {
        ...state,
        runs: { ...state.runs, [event.sessionId]: {
          status: event.status,
          startedAt: started ? event.at : previous?.startedAt ?? event.at,
          endedAt: started ? undefined : event.at,
          detail: event.detail,
        } },
        tools: started ? { ...state.tools, [event.sessionId]: [] } : state.tools,
        streaming: started ? { ...state.streaming, [event.sessionId]: "" } : state.streaming,
      };
    }
    case "agent_deleted":
      return { ...state, agents: state.agents.filter((item) => item.id !== event.agentId) };
    case "agent_delta": {
      const conversationId = event.sessionId ?? event.agentId;
      return {
        ...state,
        streaming: { ...state.streaming, [conversationId]: `${state.streaming[conversationId] ?? ""}${event.delta}` },
      };
    }
    case "agent_message": {
      const conversationId = event.sessionId ?? event.agentId;
      const existing = state.messages[conversationId] ?? [];
      const last = existing.at(-1);
      const lastUser = event.message.role === "user" ? existing.findLast((message) => message.role === "user") : undefined;
      const duplicateUser = lastUser && sameMessage(lastUser, event.message) &&
        typeof lastUser.timestamp === "number" && typeof event.message.timestamp === "number" &&
        Math.abs(lastUser.timestamp - event.message.timestamp) < 1_000;
      const messages = sameMessage(last, event.message) || duplicateUser ? existing : [...existing, event.message];
      return {
        ...state,
        messages: { ...state.messages, [conversationId]: messages },
        streaming: { ...state.streaming, [conversationId]: "" },
      };
    }
    case "agent_tool": {
      const conversationId = event.sessionId ?? event.agentId;
      const tools = state.tools[conversationId] ?? [];
      const previous = tools.find((tool) => tool.toolCallId === event.toolCallId);
      const next = [
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          phase: event.phase,
          isError: event.isError,
          detail: event.detail ?? previous?.detail,
          subagents: event.subagents ?? previous?.subagents,
          startedAt: previous?.startedAt ?? Date.now(),
          endedAt: event.phase === "end" ? Date.now() : undefined,
        },
        ...tools.filter((tool) => tool.toolCallId !== event.toolCallId),
      ].slice(0, 50);
      return { ...state, tools: { ...state.tools, [conversationId]: next } };
    }
    case "agent_queue": {
      const conversationId = event.sessionId ?? event.agentId;
      return {
        ...state,
        queues: { ...state.queues, [conversationId]: { steering: event.steering, followUp: event.followUp } },
      };
    }
    case "agent_graph":
      return { ...state, graphs: { ...state.graphs, [event.graph.agentId]: event.graph } };
    default:
      return state;
  }
}
