import { useEffect, useMemo, useState } from "react";
import type { Project } from "@kanna/shared";
import "./nuclei-workspace.css";

type Severity = "info" | "low" | "medium" | "high" | "critical";
interface Finding { id: string; templateId: string; name: string; severity: Severity; matchedAt: string; type: string; description?: string; reference?: string }
interface ScanRun { id: string; target: string; severity: Severity[]; rateLimit: number; status: "running" | "completed" | "failed" | "stopped"; startedAt: number; finishedAt?: number; findings: Finding[]; error?: string; truncated?: boolean }
interface Availability { available: boolean; version?: string; error?: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

const OPTIONS: Array<{ value: Severity; label: string }> = [
  { value: "critical", label: "Critical" }, { value: "high", label: "High" },
  { value: "medium", label: "Medium" }, { value: "low", label: "Low" }, { value: "info", label: "Info" },
];

export function NucleiWorkspace({ project, onError }: { project?: Project; onError(value: string): void }) {
  const [availability, setAvailability] = useState<Availability>();
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [target, setTarget] = useState("");
  const [severity, setSeverity] = useState<Severity[]>(["critical", "high", "medium"]);
  const [rateLimit, setRateLimit] = useState(5);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Severity | "all">("all");
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const active = runs.find((run) => run.status === "running");
  const findings = useMemo(() => selected?.findings.filter((finding) => filter === "all" || finding.severity === filter) ?? [], [selected, filter]);

  useEffect(() => {
    let mounted = true;
    void api<Availability>("/api/nuclei/availability").then((value) => { if (mounted) setAvailability(value); }).catch((error) => { if (mounted) onError(String(error)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!project) { setRuns([]); setSelectedId(undefined); return; }
    let mounted = true;
    const load = async () => {
      try {
        const value = await api<ScanRun[]>(`/api/projects/${project.id}/nuclei/runs`);
        if (mounted) { setRuns(value); setSelectedId((current) => value.some((run) => run.id === current) ? current : value[0]?.id); }
      } catch (error) { if (mounted) onError(String(error)); }
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, 1_500);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [project?.id]);

  async function start() {
    if (!project || busy) return;
    setBusy(true);
    try {
      const run = await api<ScanRun>(`/api/projects/${project.id}/nuclei/runs`, {
        method: "POST", body: JSON.stringify({ target: target.trim(), severity, rateLimit, authorized }),
      });
      setRuns((current) => [run, ...current]);
      setSelectedId(run.id);
      setAuthorized(false);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function stop() {
    if (!project || !active || busy) return;
    setBusy(true);
    try {
      const run = await api<ScanRun>(`/api/projects/${project.id}/nuclei/runs/${active.id}/stop`, { method: "POST" });
      setRuns((current) => current.map((item) => item.id === run.id ? run : item));
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="nuclei-workspace">
    <div className="nuclei-heading">
      <div><span className="nuclei-eyebrow">VULNERABILITY SCANNING / HTTP</span><h2>Nuclei Scan Lab</h2><p>Run a bounded scan of one authorized web target, then review template matches as evidence.</p></div>
      <span className={`nuclei-engine ${availability?.available ? "ready" : "missing"}`}>{availability?.available ? "● Engine ready" : "○ Engine unavailable"}</span>
    </div>
    {!availability?.available && <div className="nuclei-notice"><b>Nuclei is not available on this computer.</b><span>Install the official CLI and add <code>nuclei</code> to PATH, then reopen the app. This workspace does not download or bundle the scanner.</span><a href="https://docs.projectdiscovery.io/tools/nuclei/install" target="_blank" rel="noreferrer">Installation guide ↗</a></div>}
    <div className="nuclei-layout">
      <div className="nuclei-main">
        <section className="nuclei-card nuclei-config">
          <div className="nuclei-section-title"><span>01 / SCAN SETUP</span><small>One HTTP(S) target · HTTP templates only</small></div>
          <label className="nuclei-field">Target URL<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="https://app.example.test/" autoComplete="off" spellCheck={false} disabled={Boolean(active)} /></label>
          <div className="nuclei-config-row"><fieldset><legend>Severity</legend><div className="nuclei-options">{OPTIONS.map((option) => <label key={option.value} className={severity.includes(option.value) ? "selected" : ""}><input type="checkbox" checked={severity.includes(option.value)} disabled={Boolean(active)} onChange={(event) => setSeverity((current) => event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value))} />{option.label}</label>)}</div></fieldset>
            <label className="nuclei-field nuclei-rate">Rate limit<select value={rateLimit} onChange={(event) => setRateLimit(Number(event.target.value))} disabled={Boolean(active)}><option value={1}>1 req/s</option><option value={5}>5 req/s</option><option value={10}>10 req/s</option><option value={20}>20 req/s</option></select></label></div>
          <p className="nuclei-caution">Nuclei sends active requests. Some templates may change target state; scan only systems you are permitted to test.</p>
          <div className="nuclei-action-row"><label className="nuclei-consent"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} disabled={Boolean(active)} />I own this target or have explicit permission to scan it.</label>{active ? <button className="nuclei-stop" onClick={() => void stop()} disabled={busy}>Stop scan</button> : <button className="nuclei-start" onClick={() => void start()} disabled={!project || !availability?.available || !authorized || severity.length === 0 || !target.trim() || busy}>{busy ? "Starting…" : "Start scan →"}</button>}</div>
        </section>
        <section className="nuclei-card nuclei-results"><div className="nuclei-section-title"><span>02 / FINDINGS</span><small>{selected ? `${selected.findings.length} matches${selected.truncated ? " · limit reached" : ""}` : "No scan selected"}</small></div>
          {selected ? <><div className="nuclei-results-toolbar"><div><b>{selected.target}</b><span className={`nuclei-status ${selected.status}`}>{selected.status}</span></div><select value={filter} onChange={(event) => setFilter(event.target.value as Severity | "all")} aria-label="Filter findings by severity"><option value="all">All severity</option>{OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
            {selected.error && <div className="nuclei-run-error">{selected.error}</div>}
            <div className="nuclei-finding-list">{findings.length ? findings.map((finding) => <article className="nuclei-finding" key={finding.id}><div><span className={`nuclei-severity ${finding.severity}`}>{finding.severity}</span><span className="nuclei-template">{finding.templateId}</span></div><h3>{finding.name}</h3><p>{finding.matchedAt || "Target matched"}</p>{finding.description && <details><summary>Details</summary><p>{finding.description}</p></details>}{finding.reference && <a href={finding.reference} target="_blank" rel="noreferrer">Reference ↗</a>}</article>) : <div className="nuclei-empty">{selected.status === "running" ? "Scanning… findings will appear here as they arrive." : "No matching findings for this filter."}</div>}</div></> : <div className="nuclei-empty">Select a project, enter an authorized target, and start your first scan.</div>}
        </section>
      </div>
      <aside className="nuclei-history"><div className="nuclei-section-title"><span>SCAN HISTORY</span><small>{runs.length} runs</small></div>{runs.length ? runs.map((run) => <button key={run.id} className={`nuclei-history-item ${selected?.id === run.id ? "selected" : ""}`} onClick={() => setSelectedId(run.id)}><span className={`nuclei-history-dot ${run.status}`} /><span><b>{run.target}</b><small>{new Date(run.startedAt).toLocaleString()} · {run.findings.length} findings</small></span><em>{run.status}</em></button>) : <p className="nuclei-history-empty">Scans for this project will be saved here.</p>}<div className="nuclei-history-foot">Local CLI · JSONL findings · no Agent auto-scan</div></aside>
    </div>
  </section>;
}
