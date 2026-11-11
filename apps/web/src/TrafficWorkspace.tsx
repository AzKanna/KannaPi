import { useEffect, useMemo, useState } from "react";
import type {
  AgentChatMessage,
  AgentWorkspace,
  Project,
  RequestLabTab,
  TrafficCaptureStatus,
  TrafficCaptureSession,
  TrafficFlowDetail,
  TrafficFlowSummary,
} from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./traffic-workspace.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

function methodClass(method: string): string {
  return `method-${method.toLowerCase()}`;
}

function statusClass(status?: number): string {
  if (!status) return "pending";
  if (status >= 500) return "server-error";
  if (status >= 400) return "client-error";
  if (status >= 300) return "redirect";
  return "success";
}

function formatBytes(value?: number): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(value < 10_240 ? 1 : 0)} KB`;
}

function prettyBody(value?: string): string {
  if (!value) return "No body captured.";
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

function Headers({ value }: { value: Record<string, string> }) {
  const rows = Object.entries(value);
  if (!rows.length) return <p className="traffic-muted">No headers captured.</p>;
  return <dl className="traffic-headers">{rows.map(([key, item]) => <div key={key}><dt>{key}</dt><dd>{item}</dd></div>)}</dl>;
}

export function TrafficWorkspace({ project, agent, messages, streaming, initialSessionId, initialFlowId, onOpenRequestLab, onError }: {
  project?: Project;
  agent?: AgentWorkspace;
  messages: AgentChatMessage[];
  streaming: string;
  initialSessionId?: string;
  initialFlowId?: string;
  onOpenRequestLab(tabId: string): void;
  onError(value: string): void;
}) {
  const [sessions, setSessions] = useState<TrafficCaptureSession[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [flows, setFlows] = useState<TrafficFlowSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [flowId, setFlowId] = useState<string>();
  const [detail, setDetail] = useState<TrafficFlowDetail>();
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("ALL");
  const [panel, setPanel] = useState<"response" | "request">("response");
  const [loading, setLoading] = useState(true);
  const [creatingDemo, setCreatingDemo] = useState(false);
  const [analyzingFlowId, setAnalyzingFlowId] = useState<string>();
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [assistantBaseline, setAssistantBaseline] = useState(0);
  const [capture, setCapture] = useState<TrafficCaptureStatus>({
    state: "stopped", listenHost: "127.0.0.1", listenPort: 8080,
    interceptEnabled: false, mitmAvailable: false,
  });
  const [listenPort, setListenPort] = useState("8080");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [importingFlowId, setImportingFlowId] = useState<string>();

  async function loadSessions(preferred?: string) {
    const loaded = await api<TrafficCaptureSession[]>("/api/traffic/sessions");
    setSessions(loaded);
    setSessionId((current) => preferred ?? (loaded.some((item) => item.id === current) ? current : loaded[0]?.id));
  }

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      loadSessions(initialSessionId),
      api<TrafficCaptureStatus>("/api/traffic/capture").then((status) => {
        setCapture(status);
        setListenPort(String(status.listenPort));
      }),
    ]).catch((reason) => onError(String(reason))).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!sessionId) { setFlows([]); setFlowId(undefined); setDetail(undefined); return; }
    const parameters = new URLSearchParams({ limit: "100" });
    if (method !== "ALL") parameters.set("method", method);
    void api<{ rows: TrafficFlowSummary[]; total: number }>(`/api/traffic/sessions/${sessionId}/flows?${parameters}`)
      .then((value) => {
        setFlows(value.rows);
        setTotal(value.total);
        setFlowId((current) => initialFlowId && value.rows.some((item) => item.id === initialFlowId) ? initialFlowId : value.rows.some((item) => item.id === current) ? current : value.rows[0]?.id);
      })
      .catch((reason) => onError(String(reason)));
  }, [sessionId, method]);

  useEffect(() => {
    if (!sessionId || !flowId) { setDetail(undefined); return; }
    setAnalysisRequested(false);
    setAnalyzingFlowId(undefined);
    setDetail(undefined);
    void api<TrafficFlowDetail>(`/api/traffic/sessions/${sessionId}/flows/${flowId}`)
      .then((value) => {
        setDetail(value);
        if (value.flow.securityMetadata.passiveFlags?.includes("intercept-pending")) setPanel("request");
      })
      .catch((reason) => onError(String(reason)));
  }, [sessionId, flowId]);

  useEffect(() => {
    if (capture.state !== "listening" || !sessionId || capture.sessionId !== sessionId) return;
    const refresh = () => {
      const parameters = new URLSearchParams({ limit: "100" });
      if (method !== "ALL") parameters.set("method", method);
      void Promise.all([
        api<{ rows: TrafficFlowSummary[]; total: number }>(`/api/traffic/sessions/${sessionId}/flows?${parameters}`),
        api<TrafficCaptureStatus>("/api/traffic/capture"),
      ]).then(([value, status]) => {
        setFlows(value.rows);
        setTotal(value.total);
        setCapture(status);
        setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, flowCount: value.total } : item));
        setFlowId((current) => value.rows.some((item) => item.id === current) ? current : value.rows[0]?.id);
        if (flowId) void api<TrafficFlowDetail>(`/api/traffic/sessions/${sessionId}/flows/${flowId}`).then((nextDetail) => {
          setDetail(nextDetail);
          if (nextDetail.flow.securityMetadata.passiveFlags?.includes("intercept-pending")) setPanel("request");
        });
      }).catch((reason) => onError(String(reason)));
    };
    const timer = window.setInterval(refresh, 750);
    return () => window.clearInterval(timer);
  }, [capture.state, capture.sessionId, sessionId, method, flowId]);

  const visibleFlows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return flows;
    return flows.filter((flow) => `${flow.method} ${flow.host}${flow.path} ${flow.statusCode ?? ""}`.toLowerCase().includes(needle));
  }, [flows, query]);
  const allAssistantMessages = messages.filter((message) => message.role === "assistant");
  const assistantMessages = analysisRequested ? allAssistantMessages.slice(assistantBaseline).slice(-2) : [];
  const analysisComplete = analysisRequested && assistantMessages.length > 0 && !streaming && agent?.status !== "running";
  const selectedSession = sessions.find((session) => session.id === sessionId);

  async function createDemo() {
    setCreatingDemo(true);
    try {
      const created = await api<TrafficCaptureSession>("/api/traffic/demo", { method: "POST", body: "{}" });
      await loadSessions(created.id);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCreatingDemo(false); }
  }

  async function startCapture() {
    setCaptureBusy(true);
    try {
      const status = await api<TrafficCaptureStatus>("/api/traffic/capture/start", {
        method: "POST",
        body: JSON.stringify({ listenPort: Number(listenPort), interceptEnabled: capture.interceptEnabled }),
      });
      setCapture(status);
      await loadSessions(status.sessionId);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCaptureBusy(false); }
  }

  async function stopCapture() {
    setCaptureBusy(true);
    try {
      const status = await api<TrafficCaptureStatus>("/api/traffic/capture/stop", { method: "POST", body: "{}" });
      setCapture(status);
      await loadSessions(sessionId);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCaptureBusy(false); }
  }

  async function setIntercept(enabled: boolean) {
    try {
      setCapture(await api<TrafficCaptureStatus>("/api/traffic/capture/intercept", {
        method: "PATCH", body: JSON.stringify({ enabled }),
      }));
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function decide(action: "forward" | "drop") {
    if (!sessionId || !flowId) return;
    try {
      await api(`/api/traffic/sessions/${sessionId}/flows/${flowId}/decision`, {
        method: "POST", body: JSON.stringify({ action }),
      });
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function analyze() {
    if (!agent || !sessionId || !flowId) return;
    setAssistantBaseline(allAssistantMessages.length);
    setAnalysisRequested(true);
    setAnalyzingFlowId(flowId);
    try {
      await api(`/api/traffic/sessions/${sessionId}/flows/${flowId}/analyze`, {
        method: "POST",
        body: JSON.stringify({ agentId: agent.id, mode: agent.status === "running" ? "followUp" : "prompt" }),
      });
    } catch (reason) {
      setAnalyzingFlowId(undefined);
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function sendToRequestLab() {
    if (!project || !sessionId || !flowId) return;
    setImportingFlowId(flowId);
    try {
      const tab = await api<RequestLabTab>(`/api/projects/${project.id}/request-lab/tabs`, {
        method: "POST",
        body: JSON.stringify({ sourceSessionId: sessionId, sourceFlowId: flowId }),
      });
      onOpenRequestLab(tab.id);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImportingFlowId(undefined);
    }
  }

  return <section className="traffic-workspace">
    <div className="traffic-main">
      <div className="traffic-listener">
        <div className={`listener-state ${capture.state}`}><i /><span>{capture.state === "listening" ? "Proxy listening" : capture.state === "starting" ? "Starting proxy" : capture.state === "error" ? "Proxy error" : "Proxy stopped"}</span></div>
        <label className="proxy-address"><span>127.0.0.1 :</span><input aria-label="Proxy listener port" inputMode="numeric" value={listenPort} disabled={capture.state === "listening" || captureBusy} onChange={(event) => setListenPort(event.target.value.replace(/\D/g, "").slice(0, 5))} /></label>
        {capture.state === "listening" ? <button className="listener-stop" disabled={captureBusy} onClick={() => void stopCapture()}>{captureBusy ? "Stopping…" : "Stop listener"}</button> : <button className="listener-start" disabled={captureBusy} onClick={() => void startCapture()}>{captureBusy ? "Starting…" : "Start listener"}</button>}
        <label className={`intercept-switch ${capture.interceptEnabled ? "enabled" : ""}`}><input type="checkbox" checked={capture.interceptEnabled} disabled={captureBusy} onChange={(event) => void setIntercept(event.target.checked)} /><span><i />Intercept {capture.interceptEnabled ? "ON" : "OFF"}</span></label>
        <span className="listener-help" title="Set your browser HTTP and HTTPS proxy to this address. HTTPS requires trusting the mitmproxy CA from mitm.it.">?</span>
      </div>
      <div className="traffic-toolbar">
        <div className="capture-select">
          <span className="capture-dot" />
          <label>Capture
            <select value={sessionId ?? ""} onChange={(event) => setSessionId(event.target.value || undefined)}>
              {!sessions.length && <option value="">No captures</option>}
              {sessions.map((session) => <option key={session.id} value={session.id}>{session.target ?? session.id}{session.demo ? " · DEMO" : ""}</option>)}
            </select>
          </label>
        </div>
        <div className="capture-stats"><span><b>{selectedSession?.flowCount ?? 0}</b> flows</span><span><b>{selectedSession?.actionCount ?? 0}</b> actions</span></div>
        <button className="demo-capture" disabled={creatingDemo} onClick={() => void createDemo()}>{creatingDemo ? "Loading…" : sessions.some((session) => session.demo) ? "Demo loaded" : "Load demo capture"}</button>
      </div>

      {!loading && !sessions.length ? <div className="traffic-empty">
        <div className="traffic-empty-icon">⇄</div><p>Traffic storage is ready, but no capture exists yet.</p>
        <button onClick={() => void createDemo()} disabled={creatingDemo}>{creatingDemo ? "Creating demo…" : "Load a safe demo capture"}</button>
        <small>Creates four inert requests for shop.demo.local in the local database.</small>
      </div> : <>
        <div className="flow-controls">
          <div className="traffic-search"><span>⌕</span><input aria-label="Filter traffic" placeholder="Filter host, path, status…" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="method-filters">{["ALL", "GET", "POST"].map((item) => <button key={item} className={method === item ? "selected" : ""} onClick={() => setMethod(item)}>{item}</button>)}</div>
          <span className="flow-count">{visibleFlows.length} / {total}</span>
        </div>
        <div className="flow-table">
          <div className="flow-table-head"><span>Time</span><span>Method</span><span>Host / path</span><span>Status</span><span>Type</span><span>Size</span><span>Time</span></div>
          <div className="flow-table-body">{visibleFlows.map((flow) => <button key={flow.id} className={`flow-row ${flow.id === flowId ? "selected" : ""}`} onClick={() => setFlowId(flow.id)}>
            <span className="flow-time">{new Date(flow.timestampStart).toLocaleTimeString([], { hour12: false })}</span>
            <span><i className={`method-badge ${methodClass(flow.method)}`}>{flow.method}</i></span>
            <span className="flow-route"><b>{flow.host}</b><small>{flow.path}</small></span>
            <span><i className={`status-code ${flow.interceptStatus === "pending" ? "held" : statusClass(flow.statusCode)}`}>{flow.interceptStatus === "pending" ? "HELD" : flow.statusCode ?? "…"}</i></span>
            <span className="flow-type">{flow.contentType?.split(";")[0]?.replace("application/", "") ?? "—"}</span>
            <span>{formatBytes(flow.responseSize)}</span><span>{flow.totalMs != null ? `${flow.totalMs} ms` : "—"}</span>
          </button>)}</div>
        </div>
        <div className="traffic-detail">
          {!detail ? <div className="detail-loading">Select a flow to inspect its request and response.</div> : <>
            <header className="detail-title">
              <div><span className={`method-badge ${methodClass(detail.flow.method)}`}>{detail.flow.method}</span><b>{detail.flow.path}</b><small>{detail.flow.host}</small></div>
              <div>{detail.flow.securityMetadata.passiveFlags?.includes("intercept-pending") && <div className="intercept-actions"><button className="drop" onClick={() => void decide("drop")}>Drop</button><button className="forward" onClick={() => void decide("forward")}>Forward</button></div>}<button className="send-to-request-lab" disabled={!project || importingFlowId === flowId} onClick={() => void sendToRequestLab()}>{importingFlowId === flowId ? "Importing…" : "Send to Request Lab ↗"}</button>{detail.action && <span className="action-link">Action #{detail.action.seq} · {detail.action.type}</span>}<span className={`status-code ${detail.flow.securityMetadata.passiveFlags?.includes("intercept-pending") ? "held" : statusClass(detail.flow.statusCode)}`}>{detail.flow.securityMetadata.passiveFlags?.includes("intercept-pending") ? "HELD" : detail.flow.statusCode ?? "…"}</span></div>
            </header>
            <div className="detail-tabs"><button className={panel === "response" ? "selected" : ""} onClick={() => setPanel("response")}>Response</button><button className={panel === "request" ? "selected" : ""} onClick={() => setPanel("request")}>Request</button><span>{panel === "response" ? formatBytes(detail.flow.responseBody?.size) : formatBytes(detail.flow.requestBody?.size)}{detail.truncated ? " · preview truncated" : ""}</span></div>
            <div className="detail-content">
              <Headers value={panel === "response" ? detail.flow.responseHeaders : detail.flow.requestHeaders} />
              <pre><code>{prettyBody(panel === "response" ? detail.responseBodyText : detail.requestBodyText)}</code></pre>
            </div>
          </>}
        </div>
      </>}
    </div>

    <aside className="traffic-agent">
      <header><div className="agent-orb">π</div><div><span>Workspace assistant</span><b>{agent?.name ?? "No Agent selected"}</b></div>{agent && <i className={`agent-state ${agent.status}`}>{agent.status}</i>}</header>
      <div className="traffic-context-card">
        <span>Attached context</span>
        {detail ? <><b>{detail.flow.method} {detail.flow.path}</b><p>{detail.flow.statusCode} · {detail.flow.contentType?.split(";")[0] ?? "unknown type"} · {formatBytes(detail.flow.responseBody?.size)}</p><small>Sensitive headers and body fields will be redacted before analysis.</small></> : <p>Select a response from the flow table.</p>}
      </div>
      <button className="analyze-response" disabled={!agent || !detail?.flow.statusCode || agent.status === "running" || (analysisRequested && !analysisComplete)} onClick={() => void analyze()}>
        <span>✦</span><div><b>{agent?.status === "running" ? "Agent is working" : analysisComplete ? "Analyze this response again" : analysisRequested && analyzingFlowId === flowId ? "Analysis requested" : "Analyze this response"}</b><small>Summarize signals, evidence and next checks</small></div><i>→</i>
      </button>
      <div className="assistant-thread">
        <div className="assistant-thread-label"><span>Analysis</span>{(streaming || agent?.status === "running") && <i>Working</i>}</div>
        {!assistantMessages.length && !streaming && <div className="assistant-placeholder"><span>✦</span><p>{analysisRequested ? "The response is queued. The Agent will analyze this captured evidence here." : "The Agent’s response will appear here without leaving Traffic."}</p></div>}
        {assistantMessages.map((message, index) => <article key={`${index}-${message.text.slice(0, 20)}`}><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}</div><MarkdownBody>{message.text}</MarkdownBody></article>)}
        {streaming && <article className="streaming"><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}<i /></div><MarkdownBody>{streaming}</MarkdownBody></article>}
      </div>
      <footer><span>Evidence source</span><b>{capture.state === "listening" ? `Live proxy · ${capture.listenPort}` : "Local capture · read only"}</b></footer>
    </aside>
  </section>;
}
