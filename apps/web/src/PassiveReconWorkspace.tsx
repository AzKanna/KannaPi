import { useEffect, useMemo, useState } from "react";
import type {
  AgentChatMessage,
  AgentWorkspace,
  Endpoint,
  ParameterIndex,
  PassiveReconReport,
  PassiveReconSignal,
  Severity,
  TrafficCaptureSession,
  TrafficCaptureStatus,
} from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./passive-recon-workspace.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function endpointKey(endpoint: Endpoint): string {
  return `${endpoint.host}\0${endpoint.method}\0${endpoint.pathTemplate}`;
}

function severityScore(value: Severity): number {
  return ({ info: 0, low: 1, medium: 2, high: 3, critical: 4 })[value];
}

export function PassiveReconWorkspace({ agent, messages, streaming, onOpenTraffic, onError }: {
  agent?: AgentWorkspace;
  messages: AgentChatMessage[];
  streaming: string;
  onOpenTraffic(sessionId: string, flowId?: string): void;
  onError(value: string): void;
}) {
  const [sessions, setSessions] = useState<TrafficCaptureSession[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [capture, setCapture] = useState<TrafficCaptureStatus>();
  const [report, setReport] = useState<PassiveReconReport>();
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"signals" | "surface" | "parameters" | "inventory">("signals");
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const [selectedSignalKey, setSelectedSignalKey] = useState<string>();
  const [selectedEndpointKey, setSelectedEndpointKey] = useState<string>();
  const [selectedParameterName, setSelectedParameterName] = useState<string>();
  const [selectedHost, setSelectedHost] = useState<string>();
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [assistantBaseline, setAssistantBaseline] = useState(0);

  async function loadSessions(preferred?: string) {
    const [loaded, captureStatus] = await Promise.all([
      api<TrafficCaptureSession[]>("/api/traffic/sessions"),
      api<TrafficCaptureStatus>("/api/traffic/capture"),
    ]);
    setSessions(loaded);
    setCapture(captureStatus);
    setSessionId((current) => preferred ?? (loaded.some((item) => item.id === current) ? current : loaded[0]?.id));
  }

  async function loadReport(id: string, quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const loaded = await api<PassiveReconReport>(`/api/passive-recon/sessions/${id}`);
      setReport(loaded);
      setSelectedSignalKey((current) => loaded.signals.some((item) => item.key === current) ? current : loaded.signals[0]?.key);
      setSelectedEndpointKey((current) => loaded.endpoints.some((item) => endpointKey(item) === current) ? current : loaded.endpoints[0] ? endpointKey(loaded.endpoints[0]) : undefined);
      setSelectedParameterName((current) => loaded.parameters.some((item) => item.name === current) ? current : loaded.parameters[0]?.name);
      setSelectedHost((current) => loaded.hosts.some((item) => item.host === current) ? current : loaded.hosts[0]?.host);
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    void loadSessions().catch((reason) => { setLoading(false); onError(String(reason)); });
  }, []);

  useEffect(() => {
    setAnalysisRequested(false);
    if (!sessionId) { setReport(undefined); setLoading(false); return; }
    void loadReport(sessionId).catch((reason) => onError(String(reason)));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || capture?.state !== "listening" || capture.sessionId !== sessionId) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadReport(sessionId, true), loadSessions(sessionId)]).catch((reason) => onError(String(reason)));
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [sessionId, capture?.state, capture?.sessionId]);

  const filteredSignals = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (report?.signals ?? []).filter((signal) =>
      (severity === "all" || signal.severity === severity) &&
      (!needle || `${signal.title} ${signal.detail} ${signal.moduleId} ${signal.hosts.join(" ")}`.toLowerCase().includes(needle)),
    );
  }, [report, query, severity]);
  const filteredEndpoints = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (report?.endpoints ?? []).filter((endpoint) =>
      !needle || `${endpoint.method} ${endpoint.host}${endpoint.pathTemplate} ${endpoint.parameters.map((item) => item.name).join(" ")}`.toLowerCase().includes(needle),
    );
  }, [report, query]);
  const filteredParameters = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (report?.parameters ?? []).filter((parameter) =>
      !needle || `${parameter.name} ${parameter.locations.join(" ")} ${parameter.endpoints.map((item) => item.pathTemplate).join(" ")}`.toLowerCase().includes(needle),
    );
  }, [report, query]);
  const selectedSignal = report?.signals.find((item) => item.key === selectedSignalKey);
  const selectedEndpoint = report?.endpoints.find((item) => endpointKey(item) === selectedEndpointKey);
  const selectedParameter = report?.parameters.find((item) => item.name === selectedParameterName);
  const selectedHostValue = report?.hosts.find((item) => item.host === selectedHost);
  const notableSignals = (report?.signals ?? []).filter((item) => severityScore(item.severity) >= 2).length;
  const assistantAll = messages.filter((message) => message.role === "assistant");
  const assistantMessages = analysisRequested ? assistantAll.slice(assistantBaseline).slice(-2) : [];

  async function createDemo() {
    try {
      const created = await api<TrafficCaptureSession>("/api/traffic/demo", { method: "POST", body: "{}" });
      await loadSessions(created.id);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function analyze() {
    if (!agent || !sessionId || !report) return;
    setAssistantBaseline(assistantAll.length);
    setAnalysisRequested(true);
    try {
      await api(`/api/passive-recon/sessions/${sessionId}/analyze`, {
        method: "POST",
        body: JSON.stringify({ agentId: agent.id, mode: agent.status === "running" ? "followUp" : "prompt" }),
      });
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <section className="passive-recon-workspace">
    <div className="passive-recon-main">
      <header className="recon-toolbar">
        <div className="recon-title-mark">◉</div><div className="recon-title"><b>Passive Recon</b><small>Captured evidence only · zero active requests</small></div>
        <label>Capture<select value={sessionId ?? ""} onChange={(event) => setSessionId(event.target.value || undefined)}><option value="">No capture</option>{sessions.map((session) => <option value={session.id} key={session.id}>{session.target ?? session.id}{session.demo ? " · DEMO" : ""}</option>)}</select></label>
        <span className={`recon-live ${capture?.state === "listening" && capture.sessionId === sessionId ? "active" : ""}`}><i />{capture?.state === "listening" && capture.sessionId === sessionId ? "Live analysis" : "Stored capture"}</span>
        <button disabled={!sessionId || loading} onClick={() => sessionId && void loadReport(sessionId).catch((reason) => onError(String(reason)))}>↻ Refresh</button>
      </header>

      {!report && !loading ? <div className="recon-empty"><div>◉</div><h2>No captured evidence</h2><p>Passive Recon analyzes traffic already stored by KannaPi. It does not scan, crawl or contact a target.</p><div><button onClick={() => onOpenTraffic(sessionId ?? "")}>Open Traffic</button><button onClick={() => void createDemo()}>Load safe demo</button></div></div> : loading && !report ? <div className="recon-loading">Building passive surface map…</div> : report && <>
        <div className="recon-metrics">
          <article><span>Observed hosts</span><b>{report.hosts.length}</b><small>{report.hosts.reduce((total, host) => total + host.ports.length, 0)} host / port pairs</small></article>
          <article><span>Normalized endpoints</span><b>{report.endpoints.length}</b><small>{report.parameters.length} parameters indexed</small></article>
          <article><span>Passive signals</span><b>{report.signals.length}</b><small>{notableSignals} medium or higher</small></article>
          <article><span>Evidence volume</span><b>{report.analyzedFlows}</b><small>{formatBytes(report.totalRequestBytes + report.totalResponseBytes)} captured bodies</small></article>
        </div>
        <div className="recon-distributions">
          <Distribution title="Methods" values={report.methods} />
          <Distribution title="Responses" values={report.statuses} />
          <Distribution title="Content types" values={report.contentTypes.slice(0, 5)} />
          <div className="recon-coverage"><span>Coverage</span><b>{report.analyzedFlows} / {report.totalFlows} flows</b><small>{report.truncated ? "Newest 2,000 flows analyzed" : "Complete stored capture"}</small></div>
        </div>
        <div className="recon-controls">
          <nav>{(["signals", "surface", "parameters", "inventory"] as const).map((item) => <button className={view === item ? "selected" : ""} onClick={() => setView(item)} key={item}>{item === "surface" ? "Endpoints" : item[0]?.toUpperCase() + item.slice(1)}<span>{item === "signals" ? report.signals.length : item === "surface" ? report.endpoints.length : item === "parameters" ? report.parameters.length : report.hosts.length}</span></button>)}</nav>
          <div><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Filter ${view}…`} /></div>
          {view === "signals" && <select aria-label="Filter signal severity" value={severity} onChange={(event) => setSeverity(event.target.value as "all" | Severity)}><option value="all">All severity</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="info">Info</option></select>}
        </div>
        <div className="recon-content">
          {view === "signals" ? <><section className="recon-list"><header><span>Signal / evidence</span><span>Severity</span><span>Hits</span></header><div>{filteredSignals.map((signal) => <button className={signal.key === selectedSignalKey ? "selected" : ""} onClick={() => setSelectedSignalKey(signal.key)} key={signal.key}><i className={signal.severity} /><span><b>{signal.title}</b><small>{signal.moduleId} · {signal.hosts.join(", ")}</small></span><em className={signal.severity}>{signal.severity}</em><strong>{signal.count}</strong></button>)}</div></section><SignalDetail signal={selectedSignal} sessionId={sessionId} onOpenTraffic={onOpenTraffic} /></>
          : view === "surface" ? <><section className="recon-list endpoints"><header><span>Method / endpoint</span><span>Status</span><span>Params</span></header><div>{filteredEndpoints.map((endpoint) => <button className={endpointKey(endpoint) === selectedEndpointKey ? "selected" : ""} onClick={() => setSelectedEndpointKey(endpointKey(endpoint))} key={endpointKey(endpoint)}><i className={`method ${endpoint.method.toLowerCase()}`} /> <span><b>{endpoint.method} {endpoint.pathTemplate}</b><small>{endpoint.host} · {endpoint.contentTypes[0]?.split(";", 1)[0] ?? "unknown"}</small></span><em>{endpoint.observedStatusCodes.join(", ") || "—"}</em><strong>{endpoint.parameters.length}</strong></button>)}</div></section><EndpointDetail endpoint={selectedEndpoint} sessionId={sessionId} onOpenTraffic={onOpenTraffic} /></>
          : view === "parameters" ? <><section className="recon-list parameters"><header><span>Parameter / locations</span><span>Endpoints</span><span>Flows</span></header><div>{filteredParameters.map((parameter) => <button className={parameter.name === selectedParameterName ? "selected" : ""} onClick={() => setSelectedParameterName(parameter.name)} key={parameter.name}><i className="parameter">?</i><span><b>{parameter.name}</b><small>{parameter.locations.join(" · ")}</small></span><em>{parameter.endpoints.length}</em><strong>{parameter.flowIds.length}</strong></button>)}</div></section><ParameterDetail parameter={selectedParameter} sessionId={sessionId} onOpenTraffic={onOpenTraffic} /></>
          : <><section className="recon-list inventory"><header><span>Host / services</span><span>Status</span><span>Flows</span></header><div>{report.hosts.filter((host) => !query.trim() || `${host.host} ${host.ports.join(" ")}`.toLowerCase().includes(query.toLowerCase())).map((host) => <button className={host.host === selectedHost ? "selected" : ""} onClick={() => setSelectedHost(host.host)} key={host.host}><i className="host">◎</i><span><b>{host.host}</b><small>{host.schemes.join(" · ")} · {host.ports.join(", ")}</small></span><em>{host.statusCodes.join(", ") || "—"}</em><strong>{host.flowCount}</strong></button>)}</div></section><InventoryDetail host={selectedHostValue} report={report} /></>}
        </div>
      </>}
    </div>

    <aside className="passive-recon-agent">
      <header><div className="agent-orb">π</div><div><span>Optional assistant</span><b>{agent?.name ?? "No Agent selected"}</b></div>{agent && <i className={`agent-state ${agent.status}`}>{agent.status}</i>}</header>
      <div className="recon-agent-context"><span>Attached report</span>{report ? <><b>{report.target ?? report.sessionId}</b><p>{report.hosts.length} hosts · {report.endpoints.length} endpoints · {report.signals.length} signals</p><small>The Agent receives a redacted snapshot. Passive signals are not treated as confirmed vulnerabilities.</small></> : <p>Select a capture to build a report.</p>}</div>
      <button className="analyze-response" disabled={!agent || !report || agent.status === "running"} onClick={() => void analyze()}><span>✦</span><div><b>Analyze passive surface</b><small>Correlate evidence and suggest manual checks</small></div><i>→</i></button>
      <div className="assistant-thread"><div className="assistant-thread-label"><span>Recon analysis</span>{(streaming || agent?.status === "running") && <i>Working</i>}</div>{!assistantMessages.length && !streaming && <div className="assistant-placeholder"><span>◉</span><p>The deterministic report works without an Agent. Call Pi only for a second-pass interpretation.</p></div>}{assistantMessages.map((message, index) => <article key={`${index}-${message.text.slice(0, 20)}`}><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}</div><MarkdownBody>{message.text}</MarkdownBody></article>)}{streaming && <article><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}<i /></div><MarkdownBody>{streaming}</MarkdownBody></article>}</div>
      <footer><span>Mode</span><b>Read-only · captured data</b></footer>
    </aside>
  </section>;
}

function Distribution({ title, values }: { title: string; values: Array<{ name: string; count: number }> }) {
  const max = Math.max(1, ...values.map((item) => item.count));
  return <section><span>{title}</span><div>{values.slice(0, 5).map((item) => <p key={item.name}><b>{item.name}</b><i><em style={{ width: `${Math.max(5, item.count / max * 100)}%` }} /></i><strong>{item.count}</strong></p>)}</div></section>;
}

function SignalDetail({ signal, sessionId, onOpenTraffic }: { signal?: PassiveReconSignal; sessionId?: string; onOpenTraffic(sessionId: string, flowId?: string): void }) {
  if (!signal || !sessionId) return <aside className="recon-detail"><p>Select a signal to inspect its evidence.</p></aside>;
  return <aside className="recon-detail"><header><span>Passive signal</span><em className={signal.severity}>{signal.severity}</em></header><h2>{signal.title}</h2><p>{signal.detail}</p><dl><div><dt>Module</dt><dd>{signal.moduleId}</dd></div><div><dt>Category</dt><dd>{signal.category}</dd></div><div><dt>Hosts</dt><dd>{signal.hosts.join(", ")}</dd></div><div><dt>Occurrences</dt><dd>{signal.count}</dd></div></dl><section><h3>Evidence flows</h3>{signal.flowIds.slice(0, 12).map((flowId) => <button onClick={() => onOpenTraffic(sessionId, flowId)} key={flowId}>{flowId.slice(0, 22)}… <span>Open ↗</span></button>)}</section><small>This is deterministic reconnaissance evidence, not a confirmed finding.</small></aside>;
}

function EndpointDetail({ endpoint, sessionId, onOpenTraffic }: { endpoint?: Endpoint; sessionId?: string; onOpenTraffic(sessionId: string, flowId?: string): void }) {
  if (!endpoint || !sessionId) return <aside className="recon-detail"><p>Select an endpoint to inspect its shape.</p></aside>;
  return <aside className="recon-detail"><header><span>Normalized endpoint</span><em>{endpoint.authRequired === true ? "AUTH SEEN" : "AUTH UNKNOWN"}</em></header><h2>{endpoint.method} {endpoint.pathTemplate}</h2><p>{endpoint.host}</p><dl><div><dt>Status codes</dt><dd>{endpoint.observedStatusCodes.join(", ") || "—"}</dd></div><div><dt>Content types</dt><dd>{endpoint.contentTypes.map((item) => item.split(";", 1)[0]).join(", ") || "—"}</dd></div><div><dt>Parameters</dt><dd>{endpoint.parameters.map((item) => item.name).join(", ") || "None observed"}</dd></div></dl><section><h3>Evidence flows</h3>{endpoint.observedFromFlowIds.slice(-10).reverse().map((flowId) => <button onClick={() => onOpenTraffic(sessionId, flowId)} key={flowId}>{flowId.slice(0, 22)}… <span>Open ↗</span></button>)}</section></aside>;
}

function ParameterDetail({ parameter, sessionId, onOpenTraffic }: { parameter?: ParameterIndex; sessionId?: string; onOpenTraffic(sessionId: string, flowId?: string): void }) {
  if (!parameter || !sessionId) return <aside className="recon-detail"><p>Select a parameter to inspect its reuse.</p></aside>;
  return <aside className="recon-detail"><header><span>Parameter index</span><em>{parameter.locations.join(" · ")}</em></header><h2>{parameter.name}</h2><p>Observed across {parameter.endpoints.length} normalized endpoints.</p><section><h3>Endpoint reuse</h3>{parameter.endpoints.slice(0, 12).map((endpoint) => <p className="parameter-endpoint" key={`${endpoint.host}-${endpoint.method}-${endpoint.pathTemplate}`}><b>{endpoint.method}</b> {endpoint.host}{endpoint.pathTemplate}</p>)}</section><section><h3>Evidence flows</h3>{parameter.flowIds.slice(-8).reverse().map((flowId) => <button onClick={() => onOpenTraffic(sessionId, flowId)} key={flowId}>{flowId.slice(0, 22)}… <span>Open ↗</span></button>)}</section></aside>;
}

function InventoryDetail({ host, report }: { host?: PassiveReconReport["hosts"][number]; report: PassiveReconReport }) {
  if (!host) return <aside className="recon-detail"><p>Select a host to inspect its passive inventory.</p></aside>;
  return <aside className="recon-detail"><header><span>Observed host</span><em>{host.flowCount} flows</em></header><h2>{host.host}</h2><p>{host.schemes.join(" · ")} on {host.ports.join(", ") || "unknown ports"}</p><dl><div><dt>Methods</dt><dd>{host.methods.join(", ")}</dd></div><div><dt>Status codes</dt><dd>{host.statusCodes.join(", ") || "—"}</dd></div><div><dt>Content types</dt><dd>{host.contentTypes.join(", ") || "—"}</dd></div></dl><section><h3>Technology evidence</h3>{report.technologies.map((item) => <p className="technology" key={`${item.category}-${item.name}`}><span><b>{item.name}</b><small>{item.category} · {item.confidence}</small></span></p>)}</section><section><h3>Observed cookies</h3>{report.cookies.length ? report.cookies.map((item) => <p className="technology" key={item.name}><span><b>{item.name}</b><small>{[item.secure ? "Secure" : "No Secure", item.httpOnly ? "HttpOnly" : "No HttpOnly", item.sameSite ?? "No SameSite"].join(" · ")}</small></span></p>) : <p>No Set-Cookie evidence.</p>}</section></aside>;
}
