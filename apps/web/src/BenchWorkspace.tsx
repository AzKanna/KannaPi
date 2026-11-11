import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentWorkspace, BenchChallenge, BenchRun, BenchSession, BenchSessionSummary, BenchSettings, Project } from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./bench-sessions.css";
import "./bench-workspace.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

export function BenchWorkspace({ project, agent, sessions, selectedSessionId, onSelectSession, onOpenGraph, onRunDeleted, onError }: {
  project?: Project;
  agent?: AgentWorkspace;
  sessions: BenchSessionSummary[];
  selectedSessionId?: string;
  onSelectSession(id?: string): void;
  onOpenGraph(id: string): void;
  onRunDeleted(runId: string): void;
  onError(value: string): void;
}) {
  const [settings, setSettings] = useState<BenchSettings>();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [challenges, setChallenges] = useState<BenchChallenge[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [sessionDetail, setSessionDetail] = useState<BenchSession>();
  const [pane, setPane] = useState<"sessions" | "history">("sessions");
  const [configOpen, setConfigOpen] = useState(false);
  const [newCodes, setNewCodes] = useState<string[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [allowHints, setAllowHints] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const [rounds, setRounds] = useState(3);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const runListRef = useRef<HTMLDivElement>(null);
  const runListHeadingRef = useRef<HTMLHeadingElement>(null);
  const active = runs.find((run) => run.status === "running" || run.status === "stopping");
  const currentTask = active?.tasks.find((task) => task.status === "starting" || task.status === "solving");
  const pendingCount = active?.tasks.filter((task) => task.status === "queued").length ?? 0;
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedBenchSession = sessions.find((session) => session.id === selectedSessionId);
  const completed = useMemo(() => challenges.filter((item) => item.is_completed).length, [challenges]);
  const selectableCodes = useMemo(() => challenges.filter((item) =>
    !item.is_completed && !active?.tasks.some((task) => task.code === item.unique_code))
    .map((item) => item.unique_code), [challenges, active]);
  const selectedCount = selectableCodes.filter((code) => selected.includes(code)).length;

  useEffect(() => {
    let mounted = true;
    void api<BenchSettings>("/api/bench/settings").then((value) => {
      if (!mounted) return;
      setSettings(value);
      setBaseUrl(value.baseUrl);
      if (!value.tokenConfigured) setConfigOpen(true);
    }).catch((reason) => mounted && onError(String(reason)));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!project) { setRuns([]); return; }
    let mounted = true;
    const load = async () => {
      try {
        const value = await api<BenchRun[]>(`/api/projects/${project.id}/bench/runs`);
        if (!mounted) return;
        setRuns(value);
        setSelectedRunId((current) => value.some((run) => run.id === current) ? current : undefined);
      } catch (reason) { if (mounted) onError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [project?.id]);

  useEffect(() => {
    if (!project || !selectedSessionId) { setSessionDetail(undefined); return; }
    let mounted = true;
    setSessionDetail(undefined);
    const load = async () => {
      try {
        const value = await api<BenchSession>(`/api/projects/${project.id}/bench/sessions/${selectedSessionId}`);
        if (mounted) setSessionDetail(value);
      } catch (reason) { if (mounted) onError(reason instanceof Error ? reason.message : String(reason)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [project?.id, selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId) setPane("sessions");
  }, [selectedSessionId]);

  async function saveSettings() {
    setSettingsBusy(true);
    try {
      const saved = await api<BenchSettings>("/api/bench/settings", { method: "PUT", body: JSON.stringify({ baseUrl, token: token || undefined }) });
      setSettings(saved);
      setToken("");
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSettingsBusy(false); }
  }

  async function loadChallenges() {
    setRefreshBusy(true);
    try {
      const loaded = await api<BenchChallenge[]>("/api/bench/challenges", { method: "POST", body: "{}" });
      setNewCodes(challenges.length ? loaded.filter((item) => !challenges.some((previous) => previous.unique_code === item.unique_code)).map((item) => item.unique_code) : []);
      setChallenges(loaded);
      setSelected((current) => current.filter((code) => loaded.some((item) => item.unique_code === code && !item.is_completed && !active?.tasks.some((task) => task.code === code))));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRefreshBusy(false); }
  }

  async function submitTasks() {
    if (!project || !agent) return;
    setActionBusy(true);
    try {
      const run = await api<BenchRun>(active
        ? `/api/projects/${project.id}/bench/runs/${active.id}/queue`
        : `/api/projects/${project.id}/bench/runs`, {
        method: "POST",
        body: JSON.stringify({
          ...(!active ? { agentId: agent.id, minutesPerChallenge: minutes, maxRounds: rounds, maxSubmissions: 30, allowHints } : {}),
          challengeCodes: selected.filter((code) => selectableCodes.includes(code)),
          authorized,
          allowSandboxNetwork: allowNetwork,
        }),
      });
      setRuns((current) => active ? current.map((item) => item.id === run.id ? run : item) : [run, ...current]);
      setSelectedRunId(undefined);
      if (!active) onSelectSession(run.tasks[0]?.sessionId);
      setSelected([]);
      setNewCodes((current) => current.filter((code) => !run.tasks.some((item) => item.code === code)));
      setAuthorized(false);
      setAllowNetwork(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setActionBusy(false); }
  }

  async function stopRun() {
    if (!project || !active) return;
    setActionBusy(true);
    try {
      const run = await api<BenchRun>(`/api/projects/${project.id}/bench/runs/${active.id}/stop`, { method: "POST", body: "{}" });
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setActionBusy(false); }
  }

  async function stopCurrent() {
    if (!project || !active || !currentTask) return;
    setActionBusy(true);
    try {
      const run = await api<BenchRun>(`/api/projects/${project.id}/bench/runs/${active.id}/stop-current`, { method: "POST", body: "{}" });
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setActionBusy(false); }
  }

  async function cleanupRun(run: BenchRun) {
    if (!project || !run.cleanupCode || historyBusy || run.status === "running" || run.status === "stopping") return;
    if (!window.confirm(`Close the recorded Bench container for ${run.cleanupCode}? This contacts the configured platform.`)) return;
    setHistoryBusy(true);
    try {
      const updated = await api<BenchRun>(`/api/projects/${project.id}/bench/runs/${run.id}/cleanup`, {
        method: "POST", body: JSON.stringify({ authorized: true }),
      });
      setRuns((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setHistoryBusy(false); }
  }

  async function deleteRun(run: BenchRun) {
    if (!project || historyBusy || run.status === "running" || run.status === "stopping" || run.cleanupCode) return;
    if (!window.confirm(`Delete this ${run.status} Bench run and its ${run.tasks.length} challenge Session(s)?\n\nConversation, graph, logs, challenge workspaces and sandbox files for this run will be removed from this computer. This cannot be undone.`)) return;
    setHistoryBusy(true);
    try {
      await api(`/api/projects/${project.id}/bench/runs/${run.id}`, { method: "DELETE" });
      setRuns((current) => current.filter((item) => item.id !== run.id));
      showRunList();
      onRunDeleted(run.id);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setHistoryBusy(false); }
  }

  function showRunList(focusRunId?: string) {
    setSelectedRunId(undefined);
    window.requestAnimationFrame(() => {
      const previous = Array.from(runListRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((button) => button.dataset.runId === focusRunId);
      (previous ?? runListHeadingRef.current)?.focus();
    });
  }

  function toggle(code: string, checked: boolean) {
    setSelected((current) => checked ? [...new Set([...current, code])] : current.filter((item) => item !== code));
  }

  return <section className="bench-workspace">
    <header className="bench-heading">
      <div><span>TSec Benchmark / Agent Evaluation</span><h2>Bench Mode</h2><p>Discover challenges, stage a queue, and inspect each Agent session.</p></div>
      <div className="bench-heading-metrics"><span><b>{challenges.length}</b> discovered</span><span><b>{completed}</b> completed</span><span><b>{pendingCount}</b> queued</span></div>
    </header>
    <div className={`bench-live-strip ${active ? "is-active" : ""}`}>
      <div className="bench-live-copy"><span className={`bench-dot ${active?.status ?? "idle"}`} /><div><b>{currentTask ? `Running ${currentTask.code}` : active ? "Preparing next challenge" : "Queue idle"}</b><small>{active ? `${pendingCount} waiting · ${active.tasks.length} in this run · Agent ${active.agentId === agent?.id ? agent.name : active.agentId}` : "Select challenges and start a new run."}</small></div></div>
      {active && <div className="bench-live-actions"><button type="button" onClick={() => void stopCurrent()} disabled={actionBusy || !currentTask || active.status === "stopping"}>Stop current</button><button type="button" className="danger" onClick={() => void stopRun()} disabled={actionBusy || active.status === "stopping"}>Stop all</button></div>}
    </div>
    <div className="bench-layout">
      <main className="bench-main">
        <section className="bench-card bench-config">
          <div className="bench-platform-line"><div><span className="bench-eyebrow">PLATFORM</span><b>{settings?.tokenConfigured ? "Connected configuration" : "Set up Benchmark access"}</b><small>{settings?.baseUrl || "No platform URL saved"}</small></div><button type="button" className="bench-quiet-button" aria-expanded={configOpen} onClick={() => setConfigOpen((value) => !value)}>{configOpen ? "Hide setup" : "Configure"}</button><button type="button" className="bench-refresh" onClick={() => void loadChallenges()} disabled={refreshBusy || !settings?.tokenConfigured}>{refreshBusy ? "Refreshing…" : "↻ Refresh challenges"}</button></div>
          {configOpen && <div className="bench-fields">
            <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://benchmark.example.com" disabled={Boolean(active)} /></label>
            <label>Benchmark Token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={settings?.tokenConfigured ? "Saved; leave blank to keep" : "Task token"} disabled={Boolean(active)} /></label>
            <button type="button" onClick={() => void saveSettings()} disabled={settingsBusy || Boolean(active) || !baseUrl.trim()}>{settingsBusy ? "Saving..." : "Save connection"}</button>
            <small className="bench-config-note">{active ? "Connection settings are locked during a run; refreshing challenges is still available." : settings?.sdkVersion ?? "SDK protocol"}</small>
          </div>}
        </section>

        <section className="bench-card bench-challenges">
          <div className="bench-section-title bench-challenge-heading">
            <div><span>CHALLENGE INTAKE</span><h3>Choose what runs next</h3></div>
            <div className="bench-selection-actions">
              <small>{selectedCount} / {selectableCodes.length} selected</small>
              <button type="button" onClick={() => setSelected(selectableCodes)} disabled={!selectableCodes.length || selectedCount === selectableCodes.length}>Select all</button>
              <button type="button" onClick={() => setSelected((current) => selectableCodes.filter((code) => !current.includes(code)))} disabled={!selectableCodes.length}>Invert</button>
              <button type="button" onClick={() => setSelected([])} disabled={!selectedCount}>Clear</button>
            </div>
          </div>
          <div className="bench-table">
            {challenges.map((item) => { const inRun = active?.tasks.find((task) => task.code === item.unique_code); return <label key={item.unique_code} className={`bench-row ${item.is_completed ? "done" : ""} ${inRun ? "in-run" : ""}`}>
              <input type="checkbox" checked={selected.includes(item.unique_code)} disabled={item.is_completed || Boolean(inRun)} onChange={(event) => toggle(item.unique_code, event.target.checked)} />
              <span><b>{item.unique_code}{newCodes.includes(item.unique_code) && <em className="bench-new-badge">NEW</em>}</b><small>{item.difficulty} · level {item.level} · {item.total_score} pts</small></span>
              <em>{item.correct_flag_count}/{item.flag_count}</em>
              <i>{inRun ? inRun.status : item.is_completed ? "completed" : item.container_status}</i>
            </label>; })}
            {!challenges.length && <div className="bench-empty">Configure the platform, connect VPN, then refresh challenges.</div>}
          </div>
          <div className="bench-intake-footer">
            {active ? <p className="bench-inherit-note">New tasks join this run after the current queue and inherit its Agent and limits.</p> : <details className="bench-run-options"><summary>Run options <span>{minutes} min / task · {rounds} rounds · hints {allowHints ? "on" : "off"}</span></summary><div className="bench-options"><label>Minutes / challenge<input type="number" min={1} max={120} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><label>Agent rounds<input type="number" min={1} max={10} value={rounds} onChange={(event) => setRounds(Number(event.target.value))} /></label><label className="bench-check"><input type="checkbox" checked={allowHints} onChange={(event) => setAllowHints(event.target.checked)} />Allow scored hints</label></div></details>}
            <div className="bench-submit-row"><div className="bench-consents"><label className="bench-consent"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />I am authorized to test these challenge containers.</label><label className="bench-consent"><input type="checkbox" checked={allowNetwork} onChange={(event) => setAllowNetwork(event.target.checked)} />Allow sandbox network access to the VPN targets.</label></div><button type="button" className="bench-start" onClick={() => void submitTasks()} disabled={!project || !agent || !authorized || !allowNetwork || !selectedCount || actionBusy || active?.status === "stopping"}>{actionBusy ? "Working…" : active ? `Add ${selectedCount} to queue` : `Start ${selectedCount} challenge${selectedCount === 1 ? "" : "s"}`}</button></div>
          </div>
        </section>
      </main>
      <aside className="bench-history">
        <div className="bench-queue-summary"><div className="bench-section-title"><span>EXECUTION QUEUE</span><small>{active?.tasks.length ?? 0} in active run</small></div>{active ? <div className="bench-queue-items">{active.tasks.map((task, index) => <div key={task.sessionId ?? `${task.code}-${index}`} className={`bench-queue-item ${task.status}`}><span>{String(index + 1).padStart(2, "0")}</span><b>{task.code}</b><small>{task.status}</small></div>)}</div> : <p className="bench-panel-empty">The next run will appear here.</p>}</div>
        <div className="bench-tabbar" role="tablist" aria-label="Bench details"><button type="button" role="tab" aria-selected={pane === "sessions"} className={pane === "sessions" ? "selected" : ""} onClick={() => setPane("sessions")}>Sessions <span>{sessions.length}</span></button><button type="button" role="tab" aria-selected={pane === "history"} className={pane === "history" ? "selected" : ""} onClick={() => setPane("history")}>Run history <span>{runs.length}</span></button></div>
        {pane === "sessions" ? <div className="bench-session-pane">
          {selectedBenchSession && <section className="bench-session-detail" aria-label={`Session ${selectedBenchSession.challengeCode}`}>
            <header className="bench-session-detail-header"><div><span>SESSION DETAIL</span><h3>{selectedBenchSession.challengeCode}</h3><small>{selectedBenchSession.status} · {selectedBenchSession.messageCount} records</small></div><button type="button" onClick={() => onSelectSession(undefined)} aria-label="Close Session detail">×</button></header>
            {sessionDetail?.id === selectedBenchSession.id ? <div className="bench-session-body">
              <div className="bench-session-meta"><span>Agent: {selectedBenchSession.agentId === agent?.id ? agent.name : selectedBenchSession.agentId}</span><button type="button" onClick={() => onOpenGraph(selectedBenchSession.id)} disabled={!sessionDetail.graph}>View graph ↗</button></div>
              <div className="bench-session-messages">
                {sessionDetail.messagesTruncated && <p className="bench-session-empty">Older messages were trimmed to keep this session responsive.</p>}
                {sessionDetail.messages.map((message) => message.role === "tool"
                  ? <details key={message.id} className={`bench-session-tool ${message.phase ?? "completed"}`}>
                      <summary><span className="bench-dot" /><b>{message.toolName ?? "Tool activity"}</b><small>{message.phase ?? "recorded"}</small><time>{new Date(message.at).toLocaleTimeString()}</time></summary>
                      <pre>{message.text}</pre>
                    </details>
                  : <article className={`bench-session-message ${message.role}`} key={message.id}>
                      <header><b>{message.role === "user" ? "Task instruction" : "KannaPi"}</b><time>{new Date(message.at).toLocaleTimeString()}</time></header>
                      {message.role === "assistant" ? <MarkdownBody>{message.text}</MarkdownBody> : <p>{message.text}</p>}
                    </article>)}
                {!sessionDetail.messages.length && <p className="bench-session-empty">No conversation recorded for this challenge.</p>}
              </div>
            </div> : <p className="bench-session-empty">Loading session…</p>}
          </section>}
          <div className="bench-session-list">
            {sessions.map((item) => { const description = item.title ?? challenges.find((challenge) => challenge.unique_code === item.challengeCode)?.description?.trim(); return <button type="button" className={`bench-session-card ${selectedSessionId === item.id ? "selected" : ""}`} key={item.id} aria-pressed={selectedSessionId === item.id} onClick={() => onSelectSession(selectedSessionId === item.id ? undefined : item.id)}>
              <span className="bench-session-card-top"><span className="bench-session-mark">◇</span><span className={`bench-session-status ${item.status}`}>{item.status}</span></span>
              <span className="bench-session-title"><b>{item.challengeCode}</b><small>{description || "Benchmark challenge"}</small></span>
              <span className="bench-session-card-foot"><span>{item.messageCount} records</span><time>{new Date(item.createdAt).toLocaleDateString()}</time></span>
            </button>; })}
            {!sessions.length && <p className="bench-session-empty">Start a Bench run to create one session per challenge in this Project.</p>}
          </div>
        </div> : <div className="bench-history-panel">
          {selectedRun ? <>
            <header className="bench-run-detail-head">
              <button type="button" className="bench-run-back" onClick={() => showRunList(selectedRun.id)}>← Run history</button>
              <div className="bench-run-detail-title"><span className={`bench-dot ${selectedRun.status}`} /><b>{selectedRun.status}</b><small>{new Date(selectedRun.startedAt).toLocaleString()} · {selectedRun.tasks.length} task(s)</small></div>
              <div className="bench-run-detail-actions">
                {selectedRun.cleanupCode
                  ? <button type="button" className="bench-run-cleanup" title={`Close the ${selectedRun.cleanupCode} container before deleting this run`} disabled={historyBusy || selectedRun.status === "running" || selectedRun.status === "stopping"} onClick={() => void cleanupRun(selectedRun)}>Clean up container</button>
                  : <button type="button" className="bench-run-delete" disabled={historyBusy || selectedRun.status === "running" || selectedRun.status === "stopping"} onClick={() => void deleteRun(selectedRun)}>{historyBusy ? "Deleting…" : "Delete run"}</button>}
              </div>
            </header>
            <div className="bench-log-panel">
              <h3>Tasks</h3>
              {selectedRun.tasks.map((task) => <div className="bench-task" key={task.code}><b>{task.code}</b><span>{task.status}</span><small>{task.correctFlags}/{task.totalFlags || "?"} flags · {task.attempts} submit(s)</small>{task.sessionId && !task.sessionDeleted && <button type="button" onClick={() => { onSelectSession(task.sessionId); setPane("sessions"); }}>Open session</button>}{task.error && <p>{task.error}</p>}</div>)}
              <h3>Log</h3>
              <div className="bench-logs">{selectedRun.logs.slice(-80).map((log, index) => <div key={`${log.at}-${index}`} className={`bench-log ${log.kind}`}><time>{new Date(log.at).toLocaleTimeString()}</time><span>{log.challengeCode ?? log.kind}</span><p>{log.text}</p></div>)}</div>
            </div>
          </> : <>
            <h3 className="bench-run-list-heading" ref={runListHeadingRef} tabIndex={-1}><span>Recorded runs</span><small>{runs.length} total</small></h3>
            <div className="bench-run-list" ref={runListRef}>{runs.map((run) => <button type="button" key={run.id} data-run-id={run.id} onClick={() => setSelectedRunId(run.id)}><span className={`bench-dot ${run.status}`} /><b>{run.status}</b><small>{new Date(run.startedAt).toLocaleString()} · {run.tasks.length} task(s)</small><span className="bench-run-open" aria-hidden="true">↗</span></button>)}</div>
            {!runs.length && <p className="bench-panel-empty">No Bench runs recorded for this Project.</p>}
          </>}
        </div>}
      </aside>
    </div>
  </section>;
}
