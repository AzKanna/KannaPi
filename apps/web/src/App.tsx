import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type {
  AgentCapabilities,
  AgentAttachment,
  AgentChatMessage,
  AgentChatSession,
  AgentMcpServer,
  AgentSkillCapability,
  AgentToolProfile,
  AgentWorkspace,
  AttackGraph,
  AttackGraphNode,
  BenchSession,
  BenchSessionSummary,
  KannaEvent,
  Project,
  ProjectAsset,
  ThinkingLevel,
} from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import { AssetMappingWorkspace } from "./AssetMappingWorkspace.js";
import { CyberChefWorkspace } from "./CyberChefWorkspace.js";
import { PassiveReconWorkspace } from "./PassiveReconWorkspace.js";
import { RequestLabWorkspace } from "./RequestLabWorkspace.js";
import { NucleiWorkspace } from "./NucleiWorkspace.js";
import { BenchWorkspace } from "./BenchWorkspace.js";
import { SshWorkspace } from "./SshWorkspace.js";
import { SettingsWorkspace } from "./SettingsWorkspace.js";
import { TrafficWorkspace } from "./TrafficWorkspace.js";
import { PcapWorkspace } from "./PcapWorkspace.js";
import { ThinkingLevelSlider } from "./ThinkingLevelSlider.js";
import { ChatContextControls } from "./RuntimeControls.js";
import { SubagentCards } from "./SubagentCards.js";
import { groupChatTurns } from "./chat-presentation.js";
import { isNearChatBottom } from "./chat-scroll.js";
import { initialState, reduceEvent, type ChatRunActivity, type ToolActivity } from "./state.js";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, sidebarWidthBounds } from "./workspace-layout.js";
import "@yunyoujun/ak-ui/style.css";
import "./styles.css";
import "./management.css";
import "./agent-activity.css";
import "./theme.css";
import "./ak-ui-adapter.css";
import "./v2-ui.css";
import "./agent-shell-refresh.css";

interface ModelConfig {
  configured: boolean;
  keyConfigured: boolean;
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  modelId?: string;
  modelName?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  supportsImages?: boolean;
  thinkingLevel?: ThinkingLevel;
}

interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  keyConfigured: boolean;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
}

interface PendingAttachment {
  key: string;
  file: File;
}

const UI_SCALE_STORAGE_KEY = "kanna.ui-scale";
const SIDEBAR_WIDTH_STORAGE_KEY = "kanna.sidebar-width";
const THEME_STORAGE_KEY = "kanna.theme";
type ThemeMode = "light" | "dark";

function storedTheme(): ThemeMode {
  try {
    const desktopTheme = window.kannaDesktop?.initialTheme;
    if (desktopTheme === "dark" || desktopTheme === "light") return desktopTheme;
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  catch { return "light"; }
}

function storedUiScale(): number {
  try {
    const value = Number(localStorage.getItem(UI_SCALE_STORAGE_KEY));
    return Number.isFinite(value) && value >= 80 && value <= 140 ? value : 100;
  } catch {
    return 100;
  }
}

function storedSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored === null) return DEFAULT_SIDEBAR_WIDTH;
    const value = Number(stored);
    return Number.isFinite(value) ? clampSidebarWidth(value, window.innerWidth) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export function App() {
  const [state, dispatch] = useReducer(reduceEvent, initialState);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [sessions, setSessions] = useState<AgentChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [benchSessions, setBenchSessions] = useState<BenchSessionSummary[]>([]);
  const [benchSessionsExpanded, setBenchSessionsExpanded] = useState(true);
  const [selectedBenchSessionId, setSelectedBenchSessionId] = useState<string>();
  const [graphSessionId, setGraphSessionId] = useState("latest");
  const [sessionGraph, setSessionGraph] = useState<AttackGraph | null>();
  const [composer, setComposer] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [thinkingBusy, setThinkingBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<Project>();
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentWorkspace>();
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [editingSession, setEditingSession] = useState<AgentChatSession>();
  const [sessionBusy, setSessionBusy] = useState(false);
  const [benchSessionBusy, setBenchSessionBusy] = useState(false);
  const [managementBusy, setManagementBusy] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"chat" | "traffic" | "pcap" | "passive-recon" | "request-lab" | "nuclei" | "bench" | "assets" | "cyberchef" | "attack-graph" | "ssh" | "settings">(() => {
    const requested = new URLSearchParams(location.search).get("workspace");
    return requested === "traffic" || requested === "pcap" || requested === "passive-recon" || requested === "request-lab" || requested === "nuclei" || requested === "bench" || requested === "assets" || requested === "cyberchef" || requested === "attack-graph" || requested === "ssh" || requested === "settings"
      ? requested
      : "chat";
  });
  const [requestLabTabId, setRequestLabTabId] = useState<string>();
  const [trafficTarget, setTrafficTarget] = useState<{ sessionId?: string; flowId?: string }>({});
  const [capabilities, setCapabilities] = useState<AgentCapabilities>({ skills: [], mcpServers: [], plugins: [] });
  const [modelConfig, setModelConfig] = useState<ModelConfig>({ configured: false, keyConfigured: false });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [uiScale, setUiScale] = useState(storedUiScale);
  const [theme, setTheme] = useState<ThemeMode>(storedTheme);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [restoring, setRestoring] = useState(true);
  const chatRef = useRef<HTMLElement>(null);
  const stickToChatBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();

  const attachChat = useCallback((element: HTMLElement | null) => {
    chatRef.current = element;
    if (element && stickToChatBottomRef.current) element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* private browsing */ }
    if (window.kannaDesktop) void window.kannaDesktop.setTheme(theme).catch((reason) => setError(String(reason)));
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, String(uiScale));
    const factor = uiScale / 100;
    if (window.kannaDesktop) {
      void window.kannaDesktop.setUiScale(factor).catch((reason) => setError(String(reason)));
      return;
    }
    const root = document.getElementById("root");
    if (!root) return;
    const resize = () => {
      root.style.zoom = String(factor);
      root.style.width = `${window.innerWidth / factor}px`;
      root.style.height = `${window.innerHeight / factor}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [uiScale]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    const keepWithinViewport = () => setSidebarWidth((current) => clampSidebarWidth(current, window.innerWidth));
    window.addEventListener("resize", keepWithinViewport);
    return () => window.removeEventListener("resize", keepWithinViewport);
  }, [sidebarWidth]);

  useEffect(() => {
    void Promise.all([api<Project[]>("/api/projects"), api<ModelConfig>("/api/model-config"), api<ModelOption[]>("/api/models")]).then(([projects, config, configuredModels]) => {
      dispatch({ type: "hydrate_projects", projects });
      setSelectedProjectId((current) => current ?? projects[0]?.id);
      setModelConfig(config);
      setModels(configuredModels);
      if (!config.configured) setWorkspaceView("settings");
      if (!projects.length) setRestoring(false);
    }).catch((reason) => { setError(String(reason)); setRestoring(false); });
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ui`);
    socket.onopen = () => dispatch({ type: "connection", value: "connected" });
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as KannaEvent;
        dispatch(event);
        if (event.type === "chat_session_updated") setSessions((current) => current.map((item) => item.id === event.session.id ? event.session : item));
        if (event.type === "chat_session_deleted") {
          setSessions((current) => current.filter((item) => item.id !== event.sessionId));
          setSelectedSessionId((current) => current === event.sessionId ? undefined : current);
        }
      } catch { /* malformed server event */ }
    };
    socket.onclose = () => dispatch({ type: "connection", value: "disconnected" });
    return () => {
      socket.close();
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    void Promise.all([
      api<ProjectAsset[]>(`/api/projects/${selectedProjectId}/assets`),
      api<AgentWorkspace[]>(`/api/projects/${selectedProjectId}/agents`),
    ]).then(([assets, agents]) => {
      dispatch({ type: "hydrate_project", assets, agents });
      setSelectedAgentId((current) => agents.some((item) => item.id === current) ? current : agents[0]?.id);
      if (!agents.length) setRestoring(false);
    }).catch((reason) => { setError(String(reason)); setRestoring(false); });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) { setBenchSessions([]); return; }
    let mounted = true;
    setBenchSessions([]);
    setSelectedBenchSessionId(undefined);
    const load = async () => {
      try {
        const value = await api<BenchSessionSummary[]>(`/api/projects/${selectedProjectId}/bench/sessions`);
        if (mounted) setBenchSessions(value);
      } catch (reason) { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [selectedProjectId]);

  useEffect(() => { setGraphSessionId("latest"); setSessionGraph(undefined); }, [selectedProjectId, selectedAgentId]);

  useEffect(() => {
    if (workspaceView !== "attack-graph" || !selectedAgentId || graphSessionId === "latest") return;
    let mounted = true;
    const benchSession = benchSessions.find((item) => item.id === graphSessionId);
    const path = benchSession && selectedProjectId
      ? `/api/projects/${selectedProjectId}/bench/sessions/${graphSessionId}`
      : `/api/agents/${selectedAgentId}/sessions/${graphSessionId}/attack-graph`;
    const load = async () => {
      try {
        const value = benchSession
          ? (await api<BenchSession>(path)).graph ?? null
          : await api<AttackGraph | null>(path);
        if (mounted) setSessionGraph(value);
      } catch (reason) { if (mounted) setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    setSessionGraph(undefined);
    void load();
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [workspaceView, selectedAgentId, selectedProjectId, graphSessionId, benchSessions.some((item) => item.id === graphSessionId)]);

  useEffect(() => {
    if (!selectedAgentId) {
      setCapabilities({ skills: [], mcpServers: [], plugins: [] });
      setSessions([]);
      setSelectedSessionId(undefined);
      return;
    }
    let cancelled = false;
    setSessions([]);
    setSelectedSessionId(undefined);
    void Promise.all([
      api<AgentChatSession[]>(`/api/agents/${selectedAgentId}/sessions`),
      api<AgentCapabilities>(`/api/agents/${selectedAgentId}/capabilities`),
      api<AttackGraph | null>(`/api/agents/${selectedAgentId}/attack-graph`),
    ])
      .then(([loadedSessions, loadedCapabilities, graph]) => {
        if (cancelled) return;
        setSessions(loadedSessions);
        setSelectedSessionId((current) => loadedSessions.some((item) => item.id === current) ? current : loadedSessions[0]?.id);
        dispatch({ type: "hydrate_graph", agentId: selectedAgentId, graph: graph ?? undefined });
        setCapabilities(loadedCapabilities);
        if (!loadedSessions.length) setRestoring(false);
      })
      .catch((reason) => { setError(String(reason)); setRestoring(false); });
    return () => { cancelled = true; };
  }, [selectedAgentId]);

  useEffect(() => {
    if (!selectedAgentId || !selectedSessionId) return;
    let cancelled = false;
    void api<AgentChatMessage[]>(`/api/agents/${selectedAgentId}/sessions/${selectedSessionId}/messages`)
      .then((loadedMessages) => {
        if (cancelled) return;
        dispatch({ type: "hydrate_messages", agentId: selectedSessionId, messages: loadedMessages });
        setRestoring(false);
      })
      .catch((reason) => { setError(String(reason)); setRestoring(false); });
    return () => { cancelled = true; };
  }, [selectedAgentId, selectedSessionId]);

  useEffect(() => {
    setPendingAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [selectedAgentId, selectedSessionId]);

  const project = state.projects.find((item) => item.id === selectedProjectId);
  const agent = state.agents.find((item) => item.id === selectedAgentId);
  const selectedModel = agent
    ? models.find((item) => item.providerId === agent.providerId && item.modelId === agent.modelId)
    : undefined;
  const selectedSession = sessions.find((item) => item.id === selectedSessionId);
  const context = selectedSession ? state.contexts[selectedSession.id] : undefined;
  const messages = selectedSessionId ? state.messages[selectedSessionId] ?? [] : [];
  const turns = useMemo(() => groupChatTurns(messages), [messages]);
  const streaming = selectedSessionId ? state.streaming[selectedSessionId] ?? "" : "";
  const tools = selectedSessionId ? state.tools[selectedSessionId] ?? [] : [];
  const run = selectedSessionId ? state.runs[selectedSessionId] : undefined;
  const queue = selectedSessionId ? state.queues[selectedSessionId] : undefined;
  const graph = selectedAgentId ? state.graphs[selectedAgentId] : undefined;
  const visibleBenchSessions = benchSessions.filter((item) => item.agentId === selectedAgentId);
  const displayedGraph = graphSessionId === "latest" ? graph : sessionGraph?.sessionId === graphSessionId ? sessionGraph : undefined;
  const projectAgents = useMemo(() => state.agents.filter((item) => item.projectId === selectedProjectId), [state.agents, selectedProjectId]);

  useLayoutEffect(() => {
    if (stickToChatBottomRef.current && chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, streaming, tools, run?.status]);

  useLayoutEffect(() => {
    stickToChatBottomRef.current = true;
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [selectedSessionId]);

  async function send(mode: "prompt" | "steer" | "followUp" = "prompt") {
    if (!agent || !selectedSession || context?.compacting || uploading || (!composer.trim() && !pendingAttachments.length)) return;
    stickToChatBottomRef.current = true;
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    const message = composer.trim();
    const pending = [...pendingAttachments];
    setUploading(true);
    setUploadProgress(0);
    try {
      const uploaded: AgentAttachment[] = [];
      for (let index = 0; index < pending.length; index += 1) {
        const item = pending[index];
        if (!item) continue;
        const response = await fetch(`/api/agents/${agent.id}/attachments`, {
          method: "POST",
          headers: {
            "content-type": item.file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(item.file.name),
          },
          body: item.file,
        });
        const value = await response.json() as AgentAttachment & { error?: string };
        if (!response.ok) throw new Error(value.error ?? `Upload failed (${response.status})`);
        uploaded.push(value);
        setUploadProgress(Math.round(((index + 1) / pending.length) * 100));
      }
      setComposer("");
      setPendingAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await api(`/api/agents/${agent.id}/sessions/${selectedSession.id}/messages`, { method: "POST", body: JSON.stringify({ message, mode, attachmentIds: uploaded.map((item) => item.id) }) });
      dispatch({ type: "agent_message", agentId: agent.id, sessionId: selectedSession.id, message: { role: "user", text: message, attachments: uploaded, timestamp: Date.now() } });
    } catch (reason) {
      setComposer(message);
      setPendingAttachments(pending);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  function chooseFiles(files: FileList | null) {
    if (!files?.length) return;
    const next = [...files];
    const oversized = next.find((file) => file.size > 20 * 1024 * 1024);
    if (oversized) {
      setError(`${oversized.name} exceeds the 20 MB limit`);
      return;
    }
    setPendingAttachments((current) => {
      if (current.length + next.length > 10) {
        setError("A message can include at most 10 attachments");
        return current;
      }
      return [...current, ...next.map((file) => ({ key: crypto.randomUUID(), file }))];
    });
  }

  async function stop() {
    if (!agent || !selectedSession || stopping) return;
    setStopping(true);
    try { await api(`/api/agents/${agent.id}/sessions/${selectedSession.id}/abort`, { method: "POST", body: "{}" }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setStopping(false); }
  }

  async function deleteSession(session: AgentChatSession) {
    if (!agent || sessionBusy || agent.status === "running") return;
    if (!window.confirm(`Delete “${session.name}” and its conversation history?`)) return;
    setSessionBusy(true);
    try {
      await api(`/api/agents/${agent.id}/sessions/${session.id}`, { method: "DELETE" });
      const next = sessions.filter((item) => item.id !== session.id);
      setSessions(next);
      if (selectedSessionId === session.id) setSelectedSessionId(next[0]?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionBusy(false);
    }
  }

  async function deleteBenchSession(session: BenchSessionSummary) {
    if (!project || benchSessionBusy) return;
    if (!window.confirm(`Delete Bench Session “${session.challengeCode}” and its conversation, graph and challenge logs?\n\nThe run result and score will remain.`)) return;
    setBenchSessionBusy(true);
    try {
      await api(`/api/projects/${project.id}/bench/sessions/${session.id}`, { method: "DELETE" });
      setBenchSessions((current) => current.filter((item) => item.id !== session.id));
      if (selectedBenchSessionId === session.id) setSelectedBenchSessionId(undefined);
      if (graphSessionId === session.id) { setGraphSessionId("latest"); setSessionGraph(undefined); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBenchSessionBusy(false);
    }
  }

  function handleBenchRunDeleted(runId: string) {
    const removedIds = new Set(benchSessions.filter((item) => item.runId === runId).map((item) => item.id));
    setBenchSessions((current) => current.filter((item) => item.runId !== runId));
    setSelectedBenchSessionId((current) => current && removedIds.has(current) ? undefined : current);
    if (removedIds.has(graphSessionId)) { setGraphSessionId("latest"); setSessionGraph(undefined); }
  }

  async function deleteProject(item: Project) {
    if (managementBusy) return;
    const dependentAgents = state.agents.filter((candidate) => candidate.projectId === item.id);
    if (!window.confirm(`Delete Project “${item.name}” and its ${dependentAgents.length} Agent(s), Sessions, assets, SSH hosts and workbench records?\n\nThe workspace folder on disk will NOT be deleted.`)) return;
    setManagementBusy(true);
    try {
      await api(`/api/projects/${item.id}`, { method: "DELETE" });
      dispatch({ type: "project_deleted", projectId: item.id });
      if (selectedProjectId === item.id) {
        dispatch({ type: "hydrate_project", assets: [], agents: [] });
        setSelectedProjectId(state.projects.find((candidate) => candidate.id !== item.id)?.id);
        setSelectedAgentId(undefined);
        setSelectedSessionId(undefined);
        setSessions([]);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setManagementBusy(false); }
  }

  async function deleteAgent(item: AgentWorkspace) {
    if (managementBusy || item.status === "running") return;
    if (!window.confirm(`Delete Agent “${item.name}”, all its Sessions, conversation history, attachments, Skills and MCP settings?\n\nThe Project workspace folder will NOT be deleted.`)) return;
    setManagementBusy(true);
    try {
      await api(`/api/agents/${item.id}`, { method: "DELETE" });
      dispatch({ type: "agent_deleted", agentId: item.id });
      if (selectedAgentId === item.id) {
        setSelectedAgentId(projectAgents.find((candidate) => candidate.id !== item.id)?.id);
        setSelectedSessionId(undefined);
        setSessions([]);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setManagementBusy(false); }
  }

  async function switchModel(value: string) {
    if (!agent) return;
    const [providerId, modelId] = JSON.parse(value) as [string, string];
    try {
      const updated = await api<AgentWorkspace>(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ providerId, modelId }),
      });
      dispatch({ type: "agent_status", agent: updated });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function switchThinkingLevel(thinkingLevel: ThinkingLevel) {
    if (!agent || thinkingBusy || thinkingLevel === agent.thinkingLevel) return;
    setThinkingBusy(true);
    try {
      const updated = await api<AgentWorkspace>(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ thinkingLevel }),
      });
      dispatch({ type: "agent_status", agent: updated });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setThinkingBusy(false);
    }
  }

  return <div data-ak-ui="system" data-ui-version="2" className={`app-shell ak-font-sans-serif ${workspaceView === "traffic" || workspaceView === "pcap" || workspaceView === "passive-recon" || workspaceView === "request-lab" || workspaceView === "nuclei" || workspaceView === "bench" || workspaceView === "assets" || workspaceView === "cyberchef" || workspaceView === "settings" ? "workbench-mode" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <aside className="rail">
      <div className="rail-identity"><div className="brand-mark" aria-hidden="true">π</div><div><strong className="ak-font-serif">KannaPi</strong><small>SECURITY WORKSTATION</small></div></div>
      <span className="rail-divider" aria-hidden="true" />
      <button className={`rail-button ${workspaceView !== "settings" ? "active" : ""}`} aria-label="Agent workspace" onClick={() => setWorkspaceView("chat")}><span aria-hidden="true">⌁</span><b>Workspaces</b></button>
      <button className={`rail-button ${workspaceView === "settings" ? "active" : ""}`} aria-label="Settings" title="LLM, MCP and Skills settings" onClick={() => setWorkspaceView("settings")}><span aria-hidden="true">⚙</span><b>Settings</b></button>
      <div className="rail-spacer" />
      <div className="rail-connection" title={`Local server: ${state.connection}`}><span className={`connection ${state.connection}`} /><span>{state.connection}</span></div>
      <button className="rail-button rail-theme-toggle" type="button" aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}><span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span></button>
    </aside>

    <aside className="sidebar">
      <div className="sidebar-intro"><span>YOUR WORKSTATION <i aria-hidden="true" /></span><strong className="ak-font-serif">Workspaces</strong><small>Tools, context and agents in one place.</small></div>
      <nav className="workbench-nav" aria-label="Workspaces">
        <div className="workbench-nav-group">
          <span className="workbench-nav-label">01 / Orchestrate</span>
          <WorkspaceNavCard icon="chat" title="Agent Chat" detail="Conversation & execution" selected={workspaceView === "chat"} onClick={() => setWorkspaceView("chat")} />
          <WorkspaceNavCard icon="bench" title="Bench Mode" detail="Agent benchmark solving" selected={workspaceView === "bench"} onClick={() => setWorkspaceView("bench")} />
          <WorkspaceNavCard icon="graph" title="Attack Graph" detail="Session execution flows" selected={workspaceView === "attack-graph"} onClick={() => setWorkspaceView("attack-graph")} />
        </div>
        <div className="workbench-nav-group">
          <span className="workbench-nav-label">02 / Observe</span>
          <WorkspaceNavCard icon="traffic" title="Traffic" detail="HTTP capture & analysis" selected={workspaceView === "traffic"} onClick={() => { setTrafficTarget({}); setWorkspaceView("traffic"); }} />
          <WorkspaceNavCard icon="pcap" title="PCAP Analysis" detail="Offline traffic evidence" selected={workspaceView === "pcap"} onClick={() => setWorkspaceView("pcap")} />
          <WorkspaceNavCard icon="recon" title="Passive Recon" detail="Evidence & surface map" selected={workspaceView === "passive-recon"} onClick={() => setWorkspaceView("passive-recon")} />
          <WorkspaceNavCard icon="assets" title="Asset Mapping" detail="FOFA exposure discovery" selected={workspaceView === "assets"} onClick={() => setWorkspaceView("assets")} />
        </div>
        <div className="workbench-nav-group">
          <span className="workbench-nav-label">03 / Operate</span>
          <WorkspaceNavCard icon="request" title="Request Lab" detail="Replay & compare responses" selected={workspaceView === "request-lab"} onClick={() => setWorkspaceView("request-lab")} />
          <WorkspaceNavCard icon="nuclei" title="Nuclei Scan" detail="Template-based scanning" selected={workspaceView === "nuclei"} onClick={() => setWorkspaceView("nuclei")} />
          <WorkspaceNavCard icon="chef" title="CyberChef" detail="Decode & build recipes" selected={workspaceView === "cyberchef"} onClick={() => setWorkspaceView("cyberchef")} />
          <WorkspaceNavCard icon="ssh" title="SSH" detail="Remote hosts & commands" selected={workspaceView === "ssh"} onClick={() => setWorkspaceView("ssh")} />
        </div>
      </nav>
      <div className="sidebar-heading"><span>Projects</span><button onClick={() => setCreatingProject(true)}>＋</button></div>
      <nav className="project-list">
        {state.projects.map((item) => <div key={item.id} className={`sidebar-item-row ${item.id === selectedProjectId ? "selected" : ""}`}>
          <button className="sidebar-item-select" onClick={() => setSelectedProjectId(item.id)}>
            <span className="project-icon">{item.name.slice(0, 1).toUpperCase()}</span><span><b>{item.name}</b><small>{item.workspacePath}</small></span>
          </button>
          <div className="sidebar-item-actions"><button aria-label={`Edit Project ${item.name}`} title="Edit Project" disabled={managementBusy} onClick={() => setEditingProject(item)}>✎</button><button aria-label={`Delete Project ${item.name}`} title="Delete Project" disabled={managementBusy} onClick={() => void deleteProject(item)}>×</button></div>
        </div>)}
      </nav>
      {project && <>
        <div className="sidebar-heading"><span>Agents</span><button onClick={() => setCreatingAgent(true)}>＋</button></div>
        <nav className="agent-list">
          {projectAgents.map((item) => <div key={item.id} className={`sidebar-item-row ${item.id === selectedAgentId ? "selected" : ""}`}>
            <button className="sidebar-item-select" onClick={() => setSelectedAgentId(item.id)}><i className={`agent-dot ${item.status}`} /><span><b>{item.name}</b><small>{item.modelId} · {item.toolProfile}</small></span></button>
            <div className="sidebar-item-actions"><button aria-label={`Edit Agent ${item.name}`} title="Edit Agent" disabled={managementBusy || item.status === "running"} onClick={() => setEditingAgent(item)}>✎</button><button aria-label={`Delete Agent ${item.name}`} title="Delete Agent" disabled={managementBusy || item.status === "running"} onClick={() => void deleteAgent(item)}>×</button></div>
          </div>)}
          {!projectAgents.length && <p className="sidebar-empty">Create an Agent to begin.</p>}
        </nav>
      </>}
      {project && <section className="sidebar-bench-sessions">
        <button type="button" className="sidebar-bench-toggle" aria-expanded={benchSessionsExpanded} onClick={() => setBenchSessionsExpanded((value) => !value)}>
          <span>{benchSessionsExpanded ? "▾" : "▸"} Bench Sessions</span><small>{benchSessions.length}</small>
        </button>
        {benchSessionsExpanded && <nav className="sidebar-bench-list" aria-label="Project Bench sessions">
          {benchSessions.map((item) => <div className={`sidebar-bench-row ${selectedBenchSessionId === item.id && workspaceView === "bench" ? "selected" : ""}`} key={item.id}>
            <button type="button" className="sidebar-bench-select"
              onClick={() => { setSelectedAgentId(item.agentId); setSelectedBenchSessionId(item.id); setWorkspaceView("bench"); }}
              title={`${item.challengeCode} · ${item.status}`}>
              <span className={`bench-dot ${item.status}`} /><span><b>{item.challengeCode}</b><small>{item.status} · {new Date(item.createdAt).toLocaleString()}</small></span>
            </button>
            <button type="button" className="sidebar-bench-delete" aria-label={`Delete Bench Session ${item.challengeCode}`} title="Delete Bench Session" disabled={benchSessionBusy} onClick={() => void deleteBenchSession(item)}>×</button>
          </div>)}
          {!benchSessions.length && <p className="sidebar-empty">No Bench sessions yet.</p>}
        </nav>}
      </section>}
      {workspaceView === "chat" && agent && <>
        <div className="sidebar-heading"><span>Sessions</span><button disabled={agent.status === "running"} onClick={() => setCreatingSession(true)} title="New session">＋</button></div>
        <nav className="session-list" aria-label="Chat sessions">
          {sessions.map((item) => <div className={`session-row ${item.id === selectedSessionId ? "selected" : ""}`} key={item.id}>
            <button className="session-select" disabled={agent.status === "running" || sessionBusy} onClick={() => setSelectedSessionId(item.id)}>
              <span>◫</span><span><b>{item.name}</b><small title={item.workspacePath}>{item.workspacePath}</small></span>
            </button>
            <button className="session-edit" aria-label={`Edit Session ${item.name}`} title="Edit Session" disabled={agent.status === "running" || sessionBusy} onClick={() => setEditingSession(item)}>✎</button>
            <button className="session-delete" aria-label={`Delete Session ${item.name}`} title="Delete Session" disabled={agent.status === "running" || sessionBusy} onClick={() => void deleteSession(item)}>×</button>
          </div>)}
        </nav>
      </>}
    </aside>

    <WorkspaceResizeHandle width={sidebarWidth} onChange={setSidebarWidth} />

    <main className="workspace">
      <header className="topbar">
        <div><p>{workspaceView === "settings" ? "KannaPi Desktop" : workspaceView === "chat" && selectedSession ? `${project?.name ?? "Project"} · ${selectedSession.name}` : project?.name ?? "No project"}</p><h1 className="ak-font-serif">{workspaceView === "traffic" ? "Traffic Workspace" : workspaceView === "pcap" ? "PCAP Analysis" : workspaceView === "passive-recon" ? "Passive Recon" : workspaceView === "request-lab" ? "Request Lab / Repeater" : workspaceView === "nuclei" ? "Nuclei Scan Lab" : workspaceView === "bench" ? "Bench Mode" : workspaceView === "assets" ? "Asset Mapping Workspace" : workspaceView === "cyberchef" ? "CyberChef Workspace" : workspaceView === "attack-graph" ? "Attack Graph" : workspaceView === "ssh" ? "SSH Workspace" : workspaceView === "settings" ? "Settings" : agent?.name ?? "Choose an Agent"}</h1></div>
        {workspaceView !== "ssh" && workspaceView !== "settings" && agent && <div className="agent-controls">
          {workspaceView === "chat" && selectedSession && <ChatContextControls key={selectedSession.id} agentId={agent.id} sessionId={selectedSession.id} context={context} running={agent.status === "running"} onEvent={dispatch} onError={setError} />}
          <span className={`status-pill ${agent.status}`}>{agent.status}</span>
        </div>}
      </header>
      <AnimatePresence mode="wait" initial={false}><motion.div className={`workspace-stage workspace-stage-${workspaceView}`} key={workspaceView === "chat" ? `${workspaceView}:${selectedSessionId ?? "none"}` : workspaceView} initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }} transition={{ duration: reduceMotion ? 0.08 : 0.2, ease: [0.22, 1, 0.36, 1] }}>
      {workspaceView === "chat" ? <section className="chat" ref={attachChat} onScroll={(event) => {
        stickToChatBottomRef.current = isNearChatBottom(event.currentTarget);
      }}>
        {!agent && <Empty title="Your general Agent workspace" body={modelConfig.configured ? "Create a project and an Agent. Security testing capabilities can be attached later without changing the conversation model." : "Configure an OpenAI-compatible model, then create a project and an Agent."} />}
        {agent && !sessions.length && <Empty title="No Sessions yet" body="Create a Session from the left sidebar to start a new conversation." />}
        {agent && selectedSession && !messages.length && !streaming && run?.status !== "running" && <Empty title={`Start ${selectedSession.name}`} body={`This session works in ${selectedSession.workspacePath}. Ask a question, inspect the workspace, or give the Agent a task.`} />}
        {agent && (messages.length > 0 || streaming || run?.status === "running") && <div className="message-list">
          {(turns.length ? turns : [{ replies: [], tools: [], other: [] }]).map((turn, index, displayTurns) => {
            const latest = index === displayTurns.length - 1;
            const showingResponse = turn.replies.length > 0 || (latest && Boolean(streaming));
            const toolCalls = latest && tools.length ? tools : turn.tools.map((message, toolIndex): ToolActivity => ({
              toolCallId: message.toolCallId ?? `history-${index}-${toolIndex}`,
              toolName: message.toolName ?? "Tool",
              phase: "end",
              isError: message.isError,
              detail: message.text,
              subagents: message.subagents,
              startedAt: message.timestamp ?? 0,
              endedAt: message.timestamp,
            }));
            return <div className="chat-turn" key={turn.user?.timestamp ?? index}>
              {turn.user && <Message message={turn.user} />}
              {turn.replies.map((message, replyIndex) => <Message key={`reply-${replyIndex}`} message={message} />)}
              {latest && streaming && <Message message={{ role: "assistant", text: streaming }} streaming />}
              {!showingResponse && (toolCalls.length > 0 || (latest && run?.status === "running")) && <AgentStatusText run={latest ? run : undefined} tools={toolCalls} />}
              {toolCalls.length > 0 && <AgentActivity run={latest ? run : undefined} tools={toolCalls} />}
              {turn.other.map((message, otherIndex) => <Message key={`other-${otherIndex}`} message={message} />)}
            </div>;
          })}
        </div>}
</section> : workspaceView === "pcap" ? <PcapWorkspace project={project} agent={agent} messages={messages} streaming={streaming} onError={setError} /> : workspaceView === "traffic" ? <TrafficWorkspace project={project} agent={agent} messages={messages} streaming={streaming} initialSessionId={trafficTarget.sessionId} initialFlowId={trafficTarget.flowId} onOpenRequestLab={(tabId) => { setRequestLabTabId(tabId); setWorkspaceView("request-lab"); }} onError={setError} /> : workspaceView === "passive-recon" ? <PassiveReconWorkspace agent={agent} messages={messages} streaming={streaming} onOpenTraffic={(sessionId, flowId) => { setTrafficTarget({ sessionId: sessionId || undefined, flowId }); setWorkspaceView("traffic"); }} onError={setError} /> : workspaceView === "request-lab" ? <RequestLabWorkspace project={project} agent={agent} messages={messages} streaming={streaming} initialTabId={requestLabTabId} onOpenTraffic={() => { setTrafficTarget({}); setWorkspaceView("traffic"); }} onError={setError} /> : workspaceView === "nuclei" ? <NucleiWorkspace project={project} onError={setError} /> : workspaceView === "bench" ? <BenchWorkspace project={project} agent={agent} sessions={visibleBenchSessions} selectedSessionId={selectedBenchSessionId} onSelectSession={setSelectedBenchSessionId} onOpenGraph={(id) => { setGraphSessionId(id); setWorkspaceView("attack-graph"); }} onRunDeleted={handleBenchRunDeleted} onError={setError} /> : workspaceView === "assets" ? <AssetMappingWorkspace agent={agent} messages={messages} streaming={streaming} onError={setError} /> : workspaceView === "cyberchef" ? <CyberChefWorkspace agent={agent} messages={messages} streaming={streaming} onError={setError} /> : workspaceView === "attack-graph" ? <div className="attack-graph-shell"><label className="graph-session-picker">Session<select aria-label="Graph session" value={graphSessionId} onChange={(event) => setGraphSessionId(event.target.value)}><option value="latest">Latest Chat run</option><optgroup label="Chat sessions">{sessions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup><optgroup label="Bench sessions">{visibleBenchSessions.map((item) => <option key={item.id} value={item.id}>{item.challengeCode} · {new Date(item.createdAt).toLocaleString()}</option>)}</optgroup></select></label><AttackGraphView agentName={agent?.name} graph={displayedGraph} sessionName={graphSessionId === "latest" ? undefined : sessions.find((item) => item.id === graphSessionId)?.name ?? visibleBenchSessions.find((item) => item.id === graphSessionId)?.challengeCode} /></div> : workspaceView === "ssh" ? <SshWorkspace project={project} onError={setError} /> : <SettingsWorkspace current={modelConfig} agent={agent} capabilities={capabilities} uiScale={uiScale} onUiScaleChange={setUiScale} theme={theme} onThemeChange={setTheme} onModelSaved={(saved, configuredModels) => { setModelConfig(saved); setModels(configuredModels); }} onCapabilitiesChanged={setCapabilities} onError={setError} />}
      </motion.div></AnimatePresence>
      {workspaceView === "chat" && agent && selectedSession && <footer className="composer-wrap">
        {(queue?.steering.length || queue?.followUp.length) ? <div className="queue-note">{(queue.steering.length + queue.followUp.length)} queued instruction(s)</div> : null}
        <div className="composer">
          {!!pendingAttachments.length && <div className="pending-attachments">{pendingAttachments.map((item) => <div className="pending-attachment" key={item.key}><span>{attachmentGlyph(item.file.type)}</span><div><b title={item.file.name}>{item.file.name}</b><small>{formatBytes(item.file.size)}</small></div><button aria-label={`Remove ${item.file.name}`} disabled={uploading} onClick={() => setPendingAttachments((current) => current.filter((entry) => entry.key !== item.key))}>×</button></div>)}</div>}
          <label className="ak-field composer-field">
            <span className="composer-label-row"><span className="ak-label">Message to {agent.name}</span><small id="agent-message-hint" className="ak-field__hint">Enter to send · Shift+Enter for a new line</small></span>
            <textarea className="ak-textarea composer-textarea" aria-label="Message Agent" aria-describedby="agent-message-hint" value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="Ask a question, describe a task, or paste something to analyze…" onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(agent.status === "running" ? "followUp" : "prompt"); }
            }} />
          </label>
          <div className="composer-toolbar">
            <div className="composer-meta"><input ref={fileInputRef} type="file" multiple hidden onChange={(event) => chooseFiles(event.target.files)} /><button className="attach-button" type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()} aria-label="Add attachments" title="Add files (max 10, 20 MB each)">＋</button><span>{uploading ? `Uploading ${uploadProgress}%` : `${agent.toolProfile} tools · ${selectedSession.name}`}</span></div>
            <div className={`model-send-controls ${agent.status === "running" ? "is-running" : ""}`}>
            <label className="ak-field composer-model-field"><span className="ak-label">Model</span><select className="ak-select" aria-label="Agent model" value={JSON.stringify([agent.providerId, agent.modelId])} disabled={context?.compacting || agent.status === "running" || !models.length} onChange={(event) => void switchModel(event.target.value)}>
              {!models.some((model) => model.providerId === agent.providerId && model.modelId === agent.modelId) && <option value={JSON.stringify([agent.providerId, agent.modelId])}>{agent.modelId} (unavailable)</option>}
              {models.map((model) => <option key={`${model.providerId}/${model.modelId}`} value={JSON.stringify([model.providerId, model.modelId])} disabled={!model.keyConfigured}>{model.modelName}{models.filter((item) => item.modelId === model.modelId).length > 1 ? ` · ${model.providerName}` : ""}</option>)}
            </select></label>
            <ThinkingLevelSlider
              compact
              label="Thinking"
              value={selectedModel?.thinkingLevels.includes(agent.thinkingLevel) ? agent.thinkingLevel : (selectedModel?.thinkingLevels[0] ?? "off")}
              levels={selectedModel?.thinkingLevels ?? ["off"]}
              disabled={context?.compacting || agent.status === "running" || thinkingBusy || !selectedModel?.reasoning}
              onChange={(level) => void switchThinkingLevel(level)}
            />
            {context?.compacting ? <button className="composer-stop" onClick={() => void stop()} disabled={stopping}>{stopping ? "Stopping…" : "Stop compression ■"}</button> : agent.status === "running" ? <div className="running-actions"><button onClick={() => void send("steer")} disabled={uploading || (!composer.trim() && !pendingAttachments.length)}>Steer</button><button onClick={() => void send("followUp")} disabled={uploading || (!composer.trim() && !pendingAttachments.length)}>Queue</button><button className="composer-stop" onClick={() => void stop()} disabled={stopping}>{stopping ? "Stopping…" : "Stop ■"}</button></div> : <button className="send" onClick={() => void send()} disabled={uploading || (!composer.trim() && !pendingAttachments.length)}>{uploading ? "Uploading…" : "Send ↑"}</button>}
            </div>
          </div>
        </div>
      </footer>}
    </main>

    <aside className="inspector">
      <div className="inspector-head"><span>Context</span><div><b>{state.assets.length}</b>{project && <button onClick={() => setCreatingAsset(true)}>＋</button>}</div></div>
      <section><h2>Project assets</h2>{state.assets.map((asset) => <div className="asset" key={asset.id}><i>{asset.type.slice(0, 1).toUpperCase()}</i><div><b>{asset.name}</b><small>{asset.value}</small></div></div>)}{!state.assets.length && <p className="muted">No assets yet. The project workspace remains available as context.</p>}</section>
      {agent && <section><div className="section-title"><h2>Capabilities</h2><button onClick={() => setWorkspaceView("settings")}>Manage</button></div><div className="capability-summary"><span><b>{capabilities.skills.reduce((count, skill) => count + skill.names.length, 0)}</b> Skills</span><span><b>{capabilities.mcpServers.reduce((count, server) => count + server.toolNames.length, 0)}</b> MCP tools</span><span><b>{capabilities.plugins.length}</b> Pi Plugins</span></div></section>}
{workspaceView === "attack-graph" && displayedGraph && <section><h2>Selected session</h2><div className="graph-summary"><span><b>{displayedGraph.nodes.length}</b> nodes</span><span><b>{displayedGraph.nodes.filter((node) => node.kind === "discovery").length}</b> discoveries</span><span><b>{formatDuration(displayedGraph)}</b> duration</span></div></section>}
      <section><h2>Tool activity</h2>{tools.map((tool) => <div className="tool" key={tool.toolCallId}><span className={tool.phase === "start" ? "pulse" : tool.isError ? "failed" : "done"} /><div><b>{tool.toolName}</b><small title={tool.detail}>{tool.detail ?? (tool.phase === "start" ? "Running" : tool.isError ? "Failed" : "Completed")}</small></div></div>)}{!tools.length && <p className="muted">Tool calls will appear here while the Agent works.</p>}</section>
    </aside>

    {creatingProject && <ProjectDialog onClose={() => setCreatingProject(false)} onCreated={(created) => { dispatch({ type: "project", project: created }); setSelectedProjectId(created.id); setCreatingProject(false); }} onError={setError} />}
    {editingProject && <ProjectDialog existing={editingProject} onClose={() => setEditingProject(undefined)} onCreated={(updated) => { dispatch({ type: "project", project: updated }); setEditingProject(undefined); }} onError={setError} />}
    {creatingAgent && project && <AgentDialog project={project} modelConfig={modelConfig} onClose={() => setCreatingAgent(false)} onCreated={(created) => { dispatch({ type: "agent_status", agent: created }); setSelectedAgentId(created.id); setCreatingAgent(false); }} onError={setError} />}
    {editingAgent && project && <AgentDialog project={project} modelConfig={modelConfig} existing={editingAgent} onClose={() => setEditingAgent(undefined)} onCreated={(updated) => { dispatch({ type: "agent_status", agent: updated }); setEditingAgent(undefined); }} onError={setError} />}
    {creatingSession && agent && project && <SessionDialog agent={agent} projects={state.projects} defaultWorkspace={project.workspacePath} onClose={() => setCreatingSession(false)} onCreated={(created) => { setSessions((current) => [created, ...current]); setSelectedSessionId(created.id); setCreatingSession(false); }} onError={setError} />}
    {editingSession && agent && project && <SessionDialog agent={agent} projects={state.projects} defaultWorkspace={project.workspacePath} existing={editingSession} onClose={() => setEditingSession(undefined)} onCreated={(updated) => { setSessions((current) => current.map((item) => item.id === updated.id ? updated : item)); setEditingSession(undefined); }} onError={setError} />}
    {creatingAsset && project && <AssetDialog project={project} onClose={() => setCreatingAsset(false)} onCreated={(created) => { dispatch({ type: "asset", asset: created }); setCreatingAsset(false); }} onError={setError} />}
    {restoring && <div className="startup-overlay" role="status" aria-live="polite"><div className="startup-card"><span className="startup-mark">π</span><b>Restoring your workspace</b><small>Loading saved models, projects and sessions…</small></div></div>}
    {error && <div className="toast" role="alert"><span>{error}</span><button onClick={() => setError(undefined)}>×</button></div>}
  </div>;
}

type WorkspaceNavIcon = "chat" | "bench" | "graph" | "traffic" | "pcap" | "recon" | "assets" | "request" | "nuclei" | "chef" | "ssh";

function WorkspaceGlyph({ name }: { name: WorkspaceNavIcon }) {
  const drawing = {
    chat: <><path d="M4 5.5h16v11H9l-5 3v-14Z" /><path d="M8 10h8M8 13h5" /></>,
    bench: <><path d="M7 4h10l3 4-8 12L4 8l3-4Z" /><path d="M4 8h16M9 4l3 16 3-16" /></>,
    graph: <><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="m7 7 4 9m6-9-4 9M7 6h10" /></>,
    traffic: <><path d="M3 8h17m0 0-4-4m4 4-4 4M21 16H4m0 0 4-4m-4 4 4 4" /></>,
    pcap: <><path d="M3 17h3l2-9 3 12 2-7 2 3h6" /><path d="M3 4h18v16H3" /></>,
    recon: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5M10.5 7v7m-3.5-3.5h7" /></>,
    assets: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></>,
    request: <><path d="M4 6h16v12H4zM4 10h16M7 14h4m3 0h3" /><path d="m16 3 4 3-4 3" /></>,
    nuclei: <><path d="m12 2 8 5v10l-8 5-8-5V7l8-5Z" /><path d="M12 7v10M7 12h10M8.5 8.5l7 7m0-7-7 7" /></>,
    chef: <><path d="M6 5h12l3 7-3 7H6l-3-7 3-7Z" /><path d="m9 10 3-3 3 3-3 3 3 3" /></>,
    ssh: <><path d="m4 7 5 5-5 5M11 17h9M4 4h16v16H4" /></>,
  } satisfies Record<WorkspaceNavIcon, React.ReactNode>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{drawing[name]}</svg>;
}

function WorkspaceNavCard({ icon, title, detail, selected, onClick }: {
  icon: WorkspaceNavIcon;
  title: string;
  detail: string;
  selected: boolean;
  onClick(): void;
}) {
  return <button type="button" className={`workbench-card ${selected ? "selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={onClick}>
    <span className="workbench-card-icon"><WorkspaceGlyph name={icon} /></span>
    <span className="workbench-card-copy"><b>{title}</b><small>{detail}</small></span>
    <span className="workbench-card-arrow" aria-hidden="true">↗</span>
  </button>;
}

function Empty({ title, body }: { title: string; body: string }) { return <div className="empty-state"><div className="orbit"><span>π</span></div><h2 className="ak-font-serif">{title}</h2><p>{body}</p></div>; }

function WorkspaceResizeHandle({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const bounds = sidebarWidthBounds(window.innerWidth);
  const resize = (next: number) => onChange(clampSidebarWidth(next, window.innerWidth));
  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") resize(width - step);
    else if (event.key === "ArrowRight") resize(width + step);
    else if (event.key === "Home") resize(bounds.min);
    else if (event.key === "End") resize(bounds.max);
    else return;
    event.preventDefault();
  };
  return <div
    className={`workspace-resizer ${dragging ? "dragging" : ""}`}
    role="separator"
    aria-label="Resize Agent conversation area"
    aria-orientation="vertical"
    aria-valuemin={bounds.min}
    aria-valuemax={bounds.max}
    aria-valuenow={width}
    tabIndex={0}
    title="Drag left or right to resize · Double-click to reset"
    onDoubleClick={() => resize(DEFAULT_SIDEBAR_WIDTH)}
    onKeyDown={onKeyDown}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, width };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      resize(drag.current.width + event.clientX - drag.current.x);
    }}
    onPointerUp={stopDragging}
    onPointerCancel={stopDragging}
  ><span /></div>;
}

function AgentStatusText({ run, tools }: { run?: ChatRunActivity; tools: ToolActivity[] }) {
  const activeTool = tools.find((tool) => tool.phase === "start");
  const text = run?.status === "running"
    ? activeTool ? `Running ${activeTool.toolName}; the model has not sent reply text yet.` : tools.length ? "Tools have finished; waiting for the model's reply text." : "Waiting for the model's reply text or first tool call."
    : run?.status === "error" ? `The Agent stopped with an error${run.detail ? `: ${run.detail}` : "."}`
    : "This turn has no saved model reply text.";
  return <div className="agent-status-text" role="status"><span className="agent-status-mark">π</span><div><b>Execution status · not a model reply</b><p>{text}</p></div></div>;
}

function AgentActivity({ run, tools }: { run?: ChatRunActivity; tools: ToolActivity[] }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (run?.status !== "running") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run?.startedAt, run?.status]);
  const completed = tools.filter((tool) => tool.phase === "end").length;
  const elapsed = run ? Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1_000)) : undefined;
  const clock = elapsed === undefined ? undefined : `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  return <section className="agent-activity" aria-label="Tool calls below Agent reply">
    <div className="agent-activity-head"><span className="agent-activity-mark">⌘</span><div><b>Tool calls</b><small>{completed} completed · {tools.length} call{tools.length === 1 ? "" : "s"}</small></div>{clock && <time aria-hidden="true">{clock}</time>}</div>
    <div className="agent-activity-tools">{tools.slice().reverse().map((tool) => <div className="agent-activity-tool" key={tool.toolCallId}><span className={tool.phase === "start" ? "running" : tool.isError ? "failed" : "done"} /><div><b>{tool.toolName === "subagent" ? "Multi-Agent delegation" : tool.toolName}</b><small>{tool.phase === "start" ? "Executing…" : tool.isError ? "Failed" : "Completed"}</small>{tool.subagents?.length ? <SubagentCards items={tool.subagents} /> : null}{tool.detail && <details><summary>{tool.subagents?.length ? "Combined result" : "Details"}</summary><pre>{tool.detail}</pre></details>}</div><em>{tool.phase === "start" ? "RUNNING" : tool.isError ? "FAILED" : "DONE"}</em></div>)}</div>
  </section>;
}

function Message({ message, streaming = false }: { message: AgentChatMessage; streaming?: boolean }) {
  const text = message.text || (message.attachments?.length ? "" : message.isError ? "Tool failed" : "Tool completed");
  return <article className={`message ${message.role}`}><div className="avatar">{message.role === "user" ? "U" : message.role === "assistant" ? "π" : "T"}</div><div className="message-main"><header><b>{message.role === "user" ? "You" : message.role === "assistant" ? "KannaPi" : message.toolName ?? "Tool"}</b>{streaming && <span>working</span>}</header>{text && (message.role === "assistant" ? <MarkdownBody>{text}</MarkdownBody> : <p>{text}</p>)}{!!message.attachments?.length && <div className="message-attachments">{message.attachments.map((attachment) => <a key={attachment.id} className="message-attachment" href={`/api/agents/${attachment.agentId}/attachments/${attachment.id}`} target="_blank" rel="noreferrer"><span>{attachmentGlyph(attachment.mimeType)}</span><div><b>{attachment.name}</b><small>{formatBytes(attachment.size)} · {attachment.mimeType}</small></div></a>)}</div>}</div></article>;
}

function attachmentGlyph(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "▧";
  if (mimeType.includes("json") || mimeType.includes("javascript")) return "{ }";
  if (mimeType.startsWith("text/")) return "T";
  if (mimeType.includes("pdf")) return "PDF";
  return "□";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(graph: AttackGraph): string {
  const elapsed = Math.max(0, (graph.completedAt ?? Date.now()) - graph.startedAt);
  return elapsed < 1_000 ? `${elapsed}ms` : `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0)}s`;
}

function nodeLabel(node: AttackGraphNode): string {
  return ({
    objective: "Objective",
    analysis: "Analysis phase",
    action: "Action",
    discovery: "Discovery",
    decision: "Decision",
    outcome: "Outcome",
    prompt: "Legacy objective",
    tool: "Legacy tool event",
    response: "Legacy outcome",
  } as Record<string, string>)[node.kind] ?? "Execution step";
}

const GRAPH_NODE_WIDTH = 236;
const GRAPH_NODE_HEIGHT = 158;
const GRAPH_COLUMN_GAP = 86;
const GRAPH_ROW_GAP = 112;
const SEMANTIC_GRAPH_KINDS = new Set(["objective", "analysis", "action", "discovery", "decision", "outcome"]);

interface PositionedGraphNode {
  node: AttackGraphNode;
  x: number;
  y: number;
}

function graphLayout(graph: AttackGraph) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const depth = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const target of outgoing.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if ((indegree.get(target) ?? 0) === 0) queue.push(target);
    }
  }
  let lastDepth = Math.max(0, ...depth.values());
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    lastDepth += 1;
    depth.set(node.id, lastDepth);
  }
  const layers = new Map<number, AttackGraphNode[]>();
  for (const node of graph.nodes) {
    const level = depth.get(node.id) ?? 0;
    layers.set(level, [...(layers.get(level) ?? []), node]);
  }
  const widestLayer = Math.max(1, ...[...layers.values()].map((nodes) => nodes.length));
  const contentWidth = widestLayer * GRAPH_NODE_WIDTH + (widestLayer - 1) * GRAPH_COLUMN_GAP;
  const width = Math.max(760, contentWidth + 120);
  const positions: PositionedGraphNode[] = [];
  for (const [level, nodes] of [...layers.entries()].sort(([a], [b]) => a - b)) {
    const layerWidth = nodes.length * GRAPH_NODE_WIDTH + (nodes.length - 1) * GRAPH_COLUMN_GAP;
    const startX = (width - layerWidth) / 2;
    nodes.forEach((node, index) => positions.push({
      node,
      x: startX + index * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
      y: 54 + level * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
    }));
  }
  const positionById = new Map(positions.map((position) => [position.node.id, position]));
  return {
    width,
    height: 108 + (lastDepth + 1) * GRAPH_NODE_HEIGHT + lastDepth * GRAPH_ROW_GAP,
    positions,
    positionById,
  };
}

function AttackGraphView({ agentName, graph, sessionName }: { agentName?: string; graph?: AttackGraph; sessionName?: string }) {
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  useEffect(() => setSelectedNodeId(undefined), [graph?.runId]);
  const layout = useMemo(() => graph ? graphLayout(graph) : undefined, [graph]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId);
  if (!agentName) return <section className="attack-graph"><Empty title="Choose an Agent" body="Select an Agent to inspect its latest execution flow." /></section>;
  if (!graph) return <section className="attack-graph"><Empty title="No execution graph yet" body={sessionName ? `${sessionName} has no execution graph yet. It will appear here after the session starts.` : `Send ${agentName} a task. Its analysis stages, actions, discoveries and outcome will be summarized here automatically.`} /></section>;
  if (graph.nodes.some((node) => !SEMANTIC_GRAPH_KINDS.has(node.kind))) return <section className="attack-graph"><Empty title="Semantic graph is ready" body={`The previous run used the legacy tool-call view. Send ${agentName} a new task to generate a summarized analysis and discovery map.`} /></section>;
  return <section className="attack-graph">
    <div className="graph-toolbar">
      <div><span className={`graph-live ${graph.status}`} /> <b>{graph.status === "running" ? "Agent executing" : graph.status === "summarizing" ? "Synthesizing execution map" : "Semantic execution map"}</b><small>{new Date(graph.startedAt).toLocaleString()}</small></div>
      <span className={`graph-status ${graph.status}`}>{graph.status}</span>
    </div>
    <div className="graph-canvas" aria-label="Agent execution flow">
      {layout && <div className="graph-surface" style={{ width: layout.width, height: layout.height }}>
        <svg className="graph-links" width={layout.width} height={layout.height} aria-hidden="true">
          <defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
          {graph.edges.map((edge) => {
            const source = layout.positionById.get(edge.source);
            const target = layout.positionById.get(edge.target);
            if (!source || !target) return null;
            const x1 = source.x + GRAPH_NODE_WIDTH / 2;
            const y1 = source.y + GRAPH_NODE_HEIGHT;
            const x2 = target.x + GRAPH_NODE_WIDTH / 2;
            const y2 = target.y;
            const middleY = y1 + (y2 - y1) / 2;
            const related = !selectedNodeId || edge.source === selectedNodeId || edge.target === selectedNodeId;
            return <g key={edge.id} className={related ? "related" : "dimmed"}>
              <path className="graph-link" d={`M ${x1} ${y1} C ${x1} ${middleY}, ${x2} ${middleY}, ${x2} ${y2}`} markerEnd="url(#graph-arrow)" />
              {edge.label && <text className="graph-link-label" x={(x1 + x2) / 2} y={middleY - 7} textAnchor="middle">{edge.label}</text>}
            </g>;
          })}
        </svg>
        {layout.positions.map(({ node, x, y }) => <button
          type="button"
          className={`graph-node ${node.kind} ${node.status} ${selectedNodeId === node.id ? "selected" : ""}`}
          style={{ left: x, top: y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
          key={node.id}
          onClick={() => setSelectedNodeId((current) => current === node.id ? undefined : node.id)}
        >
          <header><span>{nodeLabel(node)}</span><i /></header>
          <h2>{node.title}</h2>
          {node.detail && <p>{node.detail}</p>}
          <footer><time>{new Date(node.timestamp).toLocaleTimeString()}</time><span>View detail ↗</span></footer>
        </button>)}
      </div>}
    </div>
    {selectedNode && <aside className="graph-detail">
      <button type="button" aria-label="Close node details" onClick={() => setSelectedNodeId(undefined)}>×</button>
      <span>{nodeLabel(selectedNode)}</span><h2>{selectedNode.title}</h2><p>{selectedNode.detail ?? "No additional detail was recorded."}</p>
    </aside>}
    <div className="graph-footnote"><span><i className="objective" />Objective</span><span><i className="analysis" />Analysis</span><span><i className="action" />Action</span><span><i className="discovery" />Discovery</span><span><i className="decision" />Decision</span><span><i className="outcome" />Outcome</span><small>AI-synthesized from observable execution events and final results</small></div>
  </section>;
}

function DialogFrame({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><div className="dialog" role="dialog" aria-modal="true"><header><h2>{title}</h2><button onClick={onClose}>×</button></header>{children}</div></div>;
}

function ProjectDialog({ existing, onClose, onCreated, onError }: { existing?: Project; onClose(): void; onCreated(value: Project): void; onError(value: string): void }) {
  const [name, setName] = useState(existing?.name ?? ""); const [workspacePath, setWorkspacePath] = useState(existing?.workspacePath ?? ""); const [description, setDescription] = useState(existing?.description ?? ""); const [busy, setBusy] = useState(false);
  return <DialogFrame title={existing ? "Edit Project" : "Create project"} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); setBusy(true); void api<Project>(existing ? `/api/projects/${existing.id}` : "/api/projects", { method: existing ? "PATCH" : "POST", body: JSON.stringify({ name, workspacePath: workspacePath || undefined, description }) }).then(onCreated).catch((reason) => onError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}>
    <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Research workspace" maxLength={80} required /></label>
    <label>Workspace path<input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="Defaults to the KannaPi repository" /></label>
    <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What will Agents work on?" /></label>
    {existing && <p className="field-help">Existing Sessions keep their selected directories. This path will be used as the default for new Sessions.</p>}
    <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : existing ? "Save Project" : "Create project"}</button>
  </form></DialogFrame>;
}

function AgentDialog({ project, modelConfig, existing, onClose, onCreated, onError }: { project: Project; modelConfig: ModelConfig; existing?: AgentWorkspace; onClose(): void; onCreated(value: AgentWorkspace): void; onError(value: string): void }) {
  const [name, setName] = useState(existing?.name ?? "General Agent"); const [profile, setProfile] = useState<AgentToolProfile>(existing?.toolProfile ?? "read-only"); const [systemPrompt, setSystemPrompt] = useState(existing?.systemPrompt ?? ""); const [busy, setBusy] = useState(false);
  return <DialogFrame title={existing ? "Edit Agent" : "Create Agent"} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); setBusy(true); void api<AgentWorkspace>(existing ? `/api/agents/${existing.id}` : `/api/projects/${project.id}/agents`, { method: existing ? "PATCH" : "POST", body: JSON.stringify({ name, toolProfile: profile, systemPrompt: systemPrompt || undefined }) }).then(onCreated).catch((reason) => onError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}>
    <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
    <label>Permission profile<select value={profile} onChange={(event) => setProfile(event.target.value as AgentToolProfile)}><option value="chat">Chat only</option><option value="read-only">Read-only workspace</option><option value="workspace">Read and edit workspace</option><option value="full">Full tools, including shell</option></select></label>
    <p className="field-help">Model: {modelConfig.modelName ?? "not configured"}. Start read-only; editing and shell access are explicit Agent-level choices.</p>
    <label>System prompt<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Optional — defaults to the general KannaPi persona" /></label>
    <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : existing ? "Save Agent" : "Create Agent"}</button>
  </form></DialogFrame>;
}

function SessionDialog({ agent, projects, defaultWorkspace, existing, onClose, onCreated, onError }: {
  agent: AgentWorkspace;
  projects: Project[];
  defaultWorkspace: string;
  existing?: AgentChatSession;
  onClose(): void;
  onCreated(value: AgentChatSession): void;
  onError(value: string): void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [workspacePath, setWorkspacePath] = useState(existing?.workspacePath ?? defaultWorkspace);
  const [busy, setBusy] = useState(false);
  return <DialogFrame title={existing ? "Edit Session" : "Create session"} onClose={onClose}><form onSubmit={(event) => {
    event.preventDefault();
    setBusy(true);
    void api<AgentChatSession>(existing ? `/api/agents/${agent.id}/sessions/${existing.id}` : `/api/agents/${agent.id}/sessions`, {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify({ name: name || undefined, workspacePath }),
    }).then(onCreated).catch((reason) => onError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
  }}>
    <label>Session name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={existing ? "Session name" : "Optional — generated automatically"} maxLength={80} required={Boolean(existing)} /></label>
    <label>Workspace directory<input list="session-workspaces" value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="F:\\workspace" required /></label>
    <datalist id="session-workspaces">{projects.map((project) => <option key={project.id} value={project.workspacePath}>{project.name}</option>)}</datalist>
    <p className="field-help">This directory becomes the Agent's working directory for this conversation. It must already exist on this computer.</p>
    <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : existing ? "Save Session" : "Create & switch"}</button>
  </form></DialogFrame>;
}

function AssetDialog({ project, onClose, onCreated, onError }: { project: Project; onClose(): void; onCreated(value: ProjectAsset): void; onError(value: string): void }) {
  const [name, setName] = useState(""); const [type, setType] = useState<ProjectAsset["type"]>("text"); const [value, setValue] = useState("");
  return <DialogFrame title="Add project asset" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void api<ProjectAsset>(`/api/projects/${project.id}/assets`, { method: "POST", body: JSON.stringify({ name, type, value }) }).then(onCreated).catch((reason) => onError(String(reason))); }}>
    <label>Name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Requirements" required /></label>
    <label>Type<select value={type} onChange={(event) => setType(event.target.value as ProjectAsset["type"])}><option value="text">Text</option><option value="url">URL</option><option value="file">File</option><option value="directory">Directory</option></select></label>
    <label>Value<textarea value={value} onChange={(event) => setValue(event.target.value)} placeholder="Path, URL, or context note" required /></label>
    <button className="primary" type="submit">Add asset</button>
  </form></DialogFrame>;
}

function ModelDialog({ current, onClose, onSaved, onError }: { current: ModelConfig; onClose(): void; onSaved(value: ModelConfig): void; onError(value: string): void }) {
  const [providerId, setProviderId] = useState(current.providerId ?? "openai-compatible");
  const [providerName, setProviderName] = useState(current.providerName ?? "OpenAI Compatible");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl ?? "https://api.openai.com/v1");
  const [modelId, setModelId] = useState(current.modelId ?? "");
  const [modelName, setModelName] = useState(current.modelName ?? "");
  const [apiKey, setApiKey] = useState("");
  const [contextWindow, setContextWindow] = useState(current.contextWindow ?? 128000);
  const [maxTokens, setMaxTokens] = useState(current.maxTokens ?? 8192);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>();
  async function testConnection() {
    setTesting(true);
    setTestResult(undefined);
    try {
      const result = await api<{ ok: true; latencyMs: number; preview: string }>("/api/model-config/test", { method: "POST", body: "{}" });
      setTestResult(`Connected in ${result.latencyMs} ms — ${result.preview}`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  }
  return <DialogFrame title="Model connection" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); void api<ModelConfig>("/api/model-config", { method: "POST", body: JSON.stringify({ providerId, providerName, baseUrl, modelId, modelName: modelName || modelId, apiKey: apiKey || undefined, contextWindow, maxTokens }) }).then(onSaved).catch((reason) => onError(String(reason))); }}>
    <div className="field-grid"><label>Provider ID<input value={providerId} onChange={(event) => setProviderId(event.target.value)} required /></label><label>Display name<input value={providerName} onChange={(event) => setProviderName(event.target.value)} required /></label></div>
    <label>OpenAI-compatible base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
    <div className="field-grid"><label>Model ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="gpt-4.1-mini" required /></label><label>Model name<input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="Shown in the UI" /></label></div>
    <label>API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={current.keyConfigured ? "Leave blank to keep the saved key" : "Required before sending messages"} required={!current.keyConfigured} /></label>
    <div className="field-grid"><label>Context window<input type="number" min="1024" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></label><label>Max output tokens<input type="number" min="256" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label></div>
    <p className="field-help">The key is written to the local Pi auth file and is never returned by the API.</p>
    {testResult && <p className="test-result" role="status">{testResult}</p>}
    <div className="dialog-actions"><button className="secondary" type="button" disabled={!current.configured || !current.keyConfigured || testing} onClick={() => void testConnection()}>{testing ? "Testing…" : "Test saved connection"}</button><button className="primary" type="submit">Save model connection</button></div>
  </form></DialogFrame>;
}

function CapabilitiesDialog({ agent, initial, onClose, onChanged, onError }: {
  agent: AgentWorkspace;
  initial: AgentCapabilities;
  onClose(): void;
  onChanged(value: AgentCapabilities): void;
  onError(value: string): void;
}) {
  const [skills, setSkills] = useState(initial.skills);
  const [servers, setServers] = useState(initial.mcpServers);
  const [skillPath, setSkillPath] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);

  function publish(nextSkills = skills, nextServers = servers) {
    setSkills(nextSkills);
    setServers(nextServers);
    onChanged({ skills: nextSkills, mcpServers: nextServers, plugins: initial.plugins });
  }

  function environment(): Record<string, string> {
    const entries = envText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Invalid environment line: ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1)] as const;
    });
    return Object.fromEntries(entries);
  }

  async function addSkill(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const added = await api<AgentSkillCapability>(`/api/agents/${agent.id}/skills`, { method: "POST", body: JSON.stringify({ path: skillPath }) });
      publish([...skills, added], servers);
      setSkillPath("");
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function removeSkill(id: string) {
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/skills/${id}`, { method: "DELETE" });
      publish(skills.filter((skill) => skill.id !== id), servers);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function addServer(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const added = await api<AgentMcpServer>(`/api/agents/${agent.id}/mcp-servers`, {
        method: "POST",
        body: JSON.stringify({
          name, transport,
          command: transport === "stdio" ? command : undefined,
          args: transport === "stdio" ? argsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [],
          url: transport !== "stdio" ? url : undefined,
          env: transport === "stdio" ? environment() : {},
        }),
      });
      publish(skills, [...servers, added]);
      setName(""); setCommand(""); setArgsText(""); setUrl(""); setEnvText("");
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function testServer(id: string) {
    setBusy(true);
    try {
      const tested = await api<AgentMcpServer>(`/api/agents/${agent.id}/mcp-servers/${id}/test`, { method: "POST", body: "{}" });
      publish(skills, servers.map((server) => server.id === id ? tested : server));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function removeServer(id: string) {
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/mcp-servers/${id}`, { method: "DELETE" });
      publish(skills, servers.filter((server) => server.id !== id));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <DialogFrame title={`Skills & MCP · ${agent.name}`} onClose={onClose}><div className="capabilities-dialog">
    <section><h3>Skills</h3><p className="field-help">Attach a SKILL.md file or a directory containing Agent Skills. Pi indexes the skills and reads the matching instructions on demand.</p>
      <div className="capability-list">{skills.map((skill) => <div className="capability-row" key={skill.id}><div><b>{skill.names.join(", ")}</b><small title={skill.path}>{skill.path}</small></div><button disabled={busy} onClick={() => void removeSkill(skill.id)}>Remove</button></div>)}{!skills.length && <p className="muted">No Skills attached.</p>}</div>
      <form className="inline-form" onSubmit={(event) => void addSkill(event)}><label>Skill path<input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder="F:\\skills\\my-skill\\SKILL.md" required /></label><button className="primary" disabled={busy}>Attach Skill</button></form>
    </section>
    <section><h3>MCP servers</h3><p className="field-help">Connect local stdio, Streamable HTTP, or legacy SSE servers such as Burp Suite. Discovered tools become Pi tools named <code>mcp__server__tool</code>.</p>
      <div className="capability-list">{servers.map((server) => <div className={`mcp-card ${server.lastError ? "has-error" : ""}`} key={server.id}><header><div><b>{server.name}</b><small>{server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}</small></div><span>{server.lastError ? "Unavailable" : `${server.toolNames.length} tools`}</span></header>{server.toolNames.length > 0 && <p>{server.toolNames.join(" · ")}</p>}{server.envKeys.length > 0 && <p>Environment: {server.envKeys.join(", ")} (values hidden)</p>}{server.lastError && <p className="mcp-error">{server.lastError}</p>}<div><button disabled={busy} onClick={() => void testServer(server.id)}>Test</button><button disabled={busy} onClick={() => void removeServer(server.id)}>Remove</button></div></div>)}{!servers.length && <p className="muted">No MCP servers configured.</p>}</div>
      <form className="mcp-form" onSubmit={(event) => void addServer(event)}><div className="field-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" required /></label><label>Transport<select value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http" | "sse")}><option value="stdio">Local stdio</option><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE (Burp)</option></select></label></div>{transport === "stdio" ? <><label>Command<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" required /></label><div className="field-grid"><label>Arguments (one per line)<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nF:\\workspace'} /></label><label>Environment (KEY=value)<textarea value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder="API_KEY=…" /></label></div></> : <label>Endpoint URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={transport === "sse" ? "http://127.0.0.1:9876" : "http://127.0.0.1:3000/mcp"} required /></label>}<button className="primary" disabled={busy}>{busy ? "Working…" : "Add & test server"}</button></form>
    </section>
  </div></DialogFrame>;
}
