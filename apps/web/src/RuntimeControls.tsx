import { useEffect, useRef, useState } from "react";
import type { AgentContextStatus, AgentRuntimeSettings, KannaEvent } from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./runtime-controls.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}
interface RuntimeConfiguration { settings: AgentRuntimeSettings; sandbox: { available: boolean; detail: string } }

export function RuntimeSettingsPanel({ onError }: { onError(message: string): void }) {
  const [config, setConfig] = useState<RuntimeConfiguration>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { let live = true; void api<RuntimeConfiguration>("/api/runtime-settings").then((value) => { if (live) setConfig(value); }).catch((error) => { if (live) onError(error.message); }); return () => { live = false; }; }, []);
  if (!config) return <p role="status">Loading execution settings…</p>;
  const settings = config.settings;
  const update = (value: AgentRuntimeSettings) => { setConfig({ ...config, settings: value }); setSaved(false); };
  const save = async () => {
    setSaving(true);
    try { setConfig(await api<RuntimeConfiguration>("/api/runtime-settings", { method: "PUT", body: JSON.stringify(settings) })); setSaved(true); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <div className="runtime-settings">
    <header className="settings-page-heading"><div><span>AGENT RUNTIME</span><h2>Execution & Context</h2><p>Isolate local tools and keep long conversations within the model's context window.</p></div></header>
    <fieldset disabled={saving}>
      <section className="runtime-card"><h3>Windows AppContainer</h3>
        <label className="runtime-switch"><input type="checkbox" checked={settings.sandbox.enabled} onChange={(event) => update({ ...settings, sandbox: { ...settings.sandbox, enabled: event.target.checked } })} /><span>Run Agent tools in a sandbox</span></label>
        <p className={config.sandbox.available ? "runtime-ready" : "runtime-warning"}>{config.sandbox.detail}</p>
        <p>Each Session uses a separate workspace snapshot. Commands, file reads and writes run inside AppContainer; changes stay in that copy. If the sandbox fails, tools fail without falling back to the host.</p>
        <label className="runtime-switch"><input type="checkbox" disabled={!settings.sandbox.enabled} checked={settings.sandbox.network} onChange={(event) => update({ ...settings, sandbox: { ...settings.sandbox, network: event.target.checked } })} /><span>Allow tool processes to access the network</span></label>
        <p>Default: offline. Network access is not restricted to a target allowlist; localhost is not exempted. LLM requests and the read-only web_search API broker run in the trusted server. Web Search has its own enable switch. MCP/SSH Agent tools are disabled in sandbox mode; manual Workspaces are unaffected.</p>
        <p>Commands use cmd.exe / Node.js, not PowerShell. Workspace imports skip common credential files, symlinks and dependencies; inspect your project for other secrets before sharing it. This is process isolation, not a virtual machine.</p>
        {!settings.sandbox.enabled && <p className="runtime-warning">Host mode: Agent tools can access your computer with your current account's permissions.</p>}
      </section>
      <section className="runtime-card"><h3>Context compression</h3>
        <label className="runtime-switch"><input type="checkbox" checked={settings.compaction.enabled} onChange={(event) => update({ ...settings, compaction: { ...settings.compaction, enabled: event.target.checked } })} /><span>Automatically compress long conversations</span></label>
        <label>Compress at {settings.compaction.thresholdPercent}% context usage<input type="range" min="50" max="95" step="5" value={settings.compaction.thresholdPercent} onChange={(event) => update({ ...settings, compaction: { ...settings.compaction, thresholdPercent: Number(event.target.value) } })} /></label>
        <label>Keep recent tokens<input type="number" min="256" max="64000" step="256" value={settings.compaction.keepRecentTokens} onChange={(event) => update({ ...settings, compaction: { ...settings.compaction, keepRecentTokens: Number(event.target.value) } })} /></label>
        <p>Pi summarizes older context and retains recent messages. Original chat history remains visible and saved. Summaries are lossy and use a billed model request. “Compress context” in chat also works when automatic compression is off.</p>
      </section>
      <section className="runtime-card"><h3>Multi-Agent delegation</h3>
        <label className="runtime-switch"><input type="checkbox" checked={settings.multiAgent.enabled} onChange={(event) => update({ ...settings, multiAgent: { ...settings.multiAgent, enabled: event.target.checked } })} /><span>Enable subagents in Agent Chat</span></label>
        <p>Scout gathers evidence, Planner makes a plan, Reviewer checks results, and Worker carries out a task. Your Agent can delegate a single task, run independent tasks in parallel, or pass results through a chain.</p>
        <label>Maximum parallel agents<input type="number" min="1" max="4" value={settings.multiAgent.maxConcurrency} onChange={(event) => update({ ...settings, multiAgent: { ...settings.multiAgent, maxConcurrency: Number(event.target.value) } })} /></label>
        <label>Timeout per delegated task (minutes)<input type="number" min="1" max="30" value={settings.multiAgent.timeoutMinutes} onChange={(event) => update({ ...settings, multiAgent: { ...settings.multiAgent, timeoutMinutes: Number(event.target.value) } })} /></label>
        <p>Each child has its own context and uses your selected model and Skills. Local tools share this Session's workspace and permission level. Stopping the chat cancels all children. Parallel Workers should be assigned separate files. Tool-free Chat agents cannot delegate.</p>
        <p>Try: “Use Scout to inspect this project, Planner to propose a change, then Worker to implement it.” Or: “Use parallel Scouts to inspect the API and the UI, then summarize both.” Additional agents make additional model requests.</p>
      </section>
      <button className="runtime-save" type="button" onClick={() => void save()}>{saving ? "Saving…" : saved ? "Saved ✓" : "Save runtime settings"}</button>
      <p>Applies to all Agents after saving. Finish execution/compression first. Start a new Session for a fresh workspace or Skill snapshot.</p>
    </fieldset>
  </div>;
}

export function ChatContextControls({ agentId, sessionId, context, running, onEvent, onError }: { agentId: string; sessionId: string; context?: AgentContextStatus; running: boolean; onEvent(event: KannaEvent): void; onError(message: string): void }) {
  const [busy, setBusy] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const path = `/api/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`;
  useEffect(() => {
    let live = true;
    void api<AgentContextStatus>(`${path}/context`).then((value) => { if (live) onEvent({ type: "agent_context", agentId, sessionId, context: value }); }).catch(() => undefined);
    return () => { live = false; };
  }, [path]);
  useEffect(() => {
    const closeWhenOutside = (event: PointerEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) detailsRef.current.open = false;
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => document.removeEventListener("pointerdown", closeWhenOutside);
  }, []);
  const compress = async () => {
    setBusy(true);
    onEvent({ type: "agent_context", agentId, sessionId, context: { ...context!, compacting: true } });
    try { onEvent({ type: "agent_context", agentId, sessionId, context: await api<AgentContextStatus>(`${path}/compact`, { method: "POST", body: "{}" }) }); }
    catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      try { onEvent({ type: "agent_context", agentId, sessionId, context: await api<AgentContextStatus>(`${path}/context`) }); } catch { /* disconnected; WebSocket refreshes after reconnect */ }
    } finally { setBusy(false); }
  };
  const usage = context?.percent != null ? `${Math.round(context.percent)}%` : "—";
  return <details ref={detailsRef} className="chat-context" onKeyDown={(event) => {
    if (event.key !== "Escape" || !detailsRef.current?.open) return;
    detailsRef.current.open = false;
    detailsRef.current.querySelector("summary")?.focus();
    event.stopPropagation();
  }}>
    <summary className="chat-context-trigger"><span aria-hidden="true">{context?.error || (context && !context.sandboxEnabled) ? "⚠" : "◈"}</span><span>{context?.error ? "Context error" : context ? `${context.sandboxEnabled ? "Sandbox" : "Host"} · ${usage}` : "Context"}</span></summary>
    <div className="chat-context-panel">
      <div className="chat-context-row"><strong>{context ? context.sandboxEnabled ? "Sandboxed execution" : "Host execution" : "Loading context"}</strong><span>{context?.percent != null ? `${usage} · ${context.tokens?.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens` : context?.compactions ? "Context summarized · usage updates on next reply" : "Usage available after first reply"}</span></div>
      <progress aria-label="Context usage" max="100" value={Math.min(100, Math.max(0, context?.percent ?? 0))} />
      <button type="button" disabled={!context || running || busy || context.compacting} onClick={() => void compress()}>{busy || context?.compacting ? "Compressing…" : "Compress context"}</button>
      {context?.error && <small role="alert" className="runtime-warning">{context.error}</small>}
      {context?.lastCompaction && <details><summary>Latest summary · {context.compactions} compression{context.compactions === 1 ? "" : "s"}</summary><div className="context-summary"><MarkdownBody>{context.lastCompaction.summary}</MarkdownBody></div></details>}
      {context?.sandboxPath && <details><summary>Sandbox workspace</summary><code>{context.sandboxPath}</code><small>Files produced here are not written back to your original workspace.</small></details>}
    </div>
  </details>;
}
