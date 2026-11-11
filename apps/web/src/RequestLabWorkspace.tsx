import { useEffect, useMemo, useState } from "react";
import type {
  AgentChatMessage,
  AgentWorkspace,
  Project,
  RequestLabExchange,
  RequestLabSendResult,
  RequestLabTab,
} from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./request-lab-workspace.css";

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

function displayBody(exchange?: RequestLabExchange): string {
  if (!exchange) return "Send the request to inspect its response.";
  if (exchange.error) return exchange.error;
  if (!exchange.responseBody) return "Response has no body.";
  const type = Object.entries(exchange.responseHeaders)
    .find(([name]) => name.toLowerCase() === "content-type")?.[1];
  if (type?.includes("json")) {
    try { return JSON.stringify(JSON.parse(exchange.responseBody), null, 2); }
    catch { /* show the original response */ }
  }
  return exchange.responseBody;
}

function statusClass(exchange?: RequestLabExchange): string {
  if (!exchange || exchange.error) return "error";
  if (!exchange.statusCode) return "idle";
  if (exchange.statusCode >= 500) return "server-error";
  if (exchange.statusCode >= 400) return "client-error";
  if (exchange.statusCode >= 300) return "redirect";
  return "success";
}

function bodyDelta(current: RequestLabExchange, baseline: RequestLabExchange): string {
  if (current.responseBody === baseline.responseBody) return "Body unchanged";
  const currentLines = current.responseBody.split(/\r?\n/);
  const baselineLines = baseline.responseBody.split(/\r?\n/);
  const shared = Math.min(currentLines.length, baselineLines.length);
  let changed = Math.abs(currentLines.length - baselineLines.length);
  for (let index = 0; index < shared; index += 1)
    if (currentLines[index] !== baselineLines[index]) changed += 1;
  return `${changed} changed line${changed === 1 ? "" : "s"}`;
}

export function RequestLabWorkspace({
  project,
  agent,
  messages,
  streaming,
  initialTabId,
  onOpenTraffic,
  onError,
}: {
  project?: Project;
  agent?: AgentWorkspace;
  messages: AgentChatMessage[];
  streaming: string;
  initialTabId?: string;
  onOpenTraffic(): void;
  onError(value: string): void;
}) {
  const [tabs, setTabs] = useState<RequestLabTab[]>([]);
  const [tabId, setTabId] = useState<string>();
  const [rawRequest, setRawRequest] = useState("");
  const [history, setHistory] = useState<RequestLabExchange[]>([]);
  const [exchangeId, setExchangeId] = useState<string>();
  const [comparisonId, setComparisonId] = useState("");
  const [sending, setSending] = useState(false);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [assistantBaseline, setAssistantBaseline] = useState(messages.filter((item) => item.role === "assistant").length);

  const selectedTab = tabs.find((item) => item.id === tabId);
  const exchange = history.find((item) => item.id === exchangeId) ?? history[0];
  const comparison = history.find((item) => item.id === comparisonId);
  const assistantMessages = analysisRequested
    ? messages.filter((item) => item.role === "assistant").slice(assistantBaseline).slice(-2)
    : [];

  async function loadTabs(preferred?: string) {
    if (!project) { setTabs([]); setTabId(undefined); return; }
    const loaded = await api<RequestLabTab[]>(`/api/projects/${project.id}/request-lab/tabs`);
    setTabs(loaded);
    setTabId((current) => {
      const desired = preferred ?? initialTabId;
      if (desired && loaded.some((item) => item.id === desired)) return desired;
      return loaded.some((item) => item.id === current) ? current : loaded[0]?.id;
    });
  }

  useEffect(() => {
    void loadTabs(initialTabId).catch((reason) => onError(String(reason)));
  }, [project?.id, initialTabId]);

  useEffect(() => {
    setRawRequest(selectedTab?.rawRequest ?? "");
    setAnalysisRequested(false);
    setComparisonId("");
    if (!selectedTab) { setHistory([]); setExchangeId(undefined); return; }
    void api<RequestLabExchange[]>(`/api/request-lab/tabs/${selectedTab.id}/history`)
      .then((loaded) => { setHistory(loaded); setExchangeId(loaded[0]?.id); })
      .catch((reason) => onError(String(reason)));
  }, [selectedTab?.id]);

  const headerRows = useMemo(() => Object.entries(exchange?.responseHeaders ?? {}), [exchange]);

  async function send() {
    if (!selectedTab || sending) return;
    setSending(true);
    try {
      const result = await api<RequestLabSendResult>(`/api/request-lab/tabs/${selectedTab.id}/send`, {
        method: "POST",
        body: JSON.stringify({ rawRequest }),
      });
      setTabs((current) => current.map((item) => item.id === result.tab.id ? result.tab : item));
      setHistory((current) => [result.exchange, ...current].slice(0, 50));
      setExchangeId(result.exchange.id);
      setComparisonId(history[0]?.id ?? "");
      if (result.exchange.error) onError(result.exchange.error);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  async function removeTab(id: string) {
    try {
      await api(`/api/request-lab/tabs/${id}`, { method: "DELETE" });
      await loadTabs();
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function analyze() {
    if (!agent || !selectedTab || !exchange) return;
    const allAssistant = messages.filter((item) => item.role === "assistant");
    setAssistantBaseline(allAssistant.length);
    setAnalysisRequested(true);
    try {
      await api(`/api/request-lab/tabs/${selectedTab.id}/analyze`, {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.id,
          mode: agent.status === "running" ? "followUp" : "prompt",
          exchangeIds: [comparison?.id, exchange.id].filter(Boolean),
        }),
      });
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <section className="request-lab-workspace">
    <div className="request-lab-main">
      <header className="request-lab-tabs">
        <div className="request-lab-tab-strip">
          {tabs.map((tab) => <div className={`request-lab-tab ${tab.id === tabId ? "selected" : ""}`} key={tab.id}>
            <button type="button" title={tab.name} onClick={() => setTabId(tab.id)}>{tab.name}</button>
            <button type="button" aria-label={`Close ${tab.name}`} onClick={() => void removeTab(tab.id)}>×</button>
          </div>)}
        </div>
        <button type="button" className="request-lab-import" onClick={onOpenTraffic}>＋ Import from Traffic</button>
      </header>

      {!selectedTab ? <div className="request-lab-empty">
        <div>↗</div><h2>No request loaded</h2><p>Select a captured HTTP request in Traffic, then choose <b>Send to Request Lab</b>.</p><button type="button" onClick={onOpenTraffic}>Open Traffic Workspace</button>
      </div> : <>
        <div className="request-lab-scope">
          <span>Scope locked</span><b>{selectedTab.allowedOrigin}</b><small>Paths, query values, headers and body can be edited. The scheme, host and port cannot change.</small>
        </div>
        <div className="request-lab-editor-grid">
          <section className="request-editor-pane">
            <header><div><span>Request</span><b>{selectedTab.name}</b></div><button type="button" disabled={sending || !rawRequest.trim()} onClick={() => void send()}>{sending ? "Sending…" : "Send request  ▶"}</button></header>
            <textarea aria-label="Raw HTTP request" spellCheck={false} value={rawRequest} onChange={(event) => setRawRequest(event.target.value)} />
            <footer><span>Manual send only</span><span>512 KB max · redirect disabled · 20 s timeout</span></footer>
          </section>
          <section className="response-view-pane">
            <header><div><span>Response</span>{exchange && <b className={statusClass(exchange)}>{exchange.error ? "ERROR" : `${exchange.statusCode} ${exchange.statusText ?? ""}`}</b>}</div>{exchange && <div><small>{exchange.durationMs ?? 0} ms</small><small>{formatBytes(new TextEncoder().encode(exchange.responseBody).byteLength)}{exchange.responseTruncated ? " · truncated" : ""}</small></div>}</header>
            {headerRows.length > 0 && <details><summary>{headerRows.length} response headers</summary><dl>{headerRows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details>}
            <pre className={exchange?.error ? "has-error" : ""}><code>{displayBody(exchange)}</code></pre>
          </section>
        </div>
        <section className="request-lab-history">
          <header><div><b>History</b><span>{history.length} run{history.length === 1 ? "" : "s"}</span></div>{exchange && history.length > 1 && <label>Compare with<select value={comparisonId} onChange={(event) => setComparisonId(event.target.value)}><option value="">None</option>{history.filter((item) => item.id !== exchange.id).map((item, index) => <option value={item.id} key={item.id}>#{history.length - index} · {item.statusCode ?? "ERR"} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}</select></label>}</header>
          <div className="request-lab-history-content">
            <div className="history-runs">{history.map((item, index) => <button type="button" className={item.id === exchange?.id ? "selected" : ""} key={item.id} onClick={() => setExchangeId(item.id)}><i className={statusClass(item)} /> <b>#{history.length - index}</b><span>{item.statusCode ?? "ERR"}</span><small>{item.durationMs ?? 0} ms</small><time>{new Date(item.createdAt).toLocaleTimeString()}</time></button>)}</div>
            {exchange && comparison && <div className="comparison-summary"><span><b>Status</b>{comparison.statusCode ?? "ERR"} → {exchange.statusCode ?? "ERR"}</span><span><b>Size</b>{formatBytes(new TextEncoder().encode(comparison.responseBody).byteLength)} → {formatBytes(new TextEncoder().encode(exchange.responseBody).byteLength)}</span><span><b>Timing</b>{comparison.durationMs ?? 0} → {exchange.durationMs ?? 0} ms</span><span><b>Content</b>{bodyDelta(exchange, comparison)}</span></div>}
          </div>
        </section>
      </>}
    </div>

    <aside className="request-lab-agent">
      <header><div className="agent-orb">π</div><div><span>Workspace assistant</span><b>{agent?.name ?? "No Agent selected"}</b></div>{agent && <i className={`agent-state ${agent.status}`}>{agent.status}</i>}</header>
      <div className="request-lab-context"><span>Attached evidence</span>{exchange ? <><b>{exchange.statusCode ?? "Error"} · {exchange.requestUrl}</b><p>{comparison ? "Current response + selected baseline" : "Current response"}</p><small>Credentials and sensitive fields are redacted before the evidence reaches the Agent.</small></> : <p>Send or select a historical response first.</p>}</div>
      <button className="analyze-response" disabled={!agent || !exchange || agent.status === "running"} onClick={() => void analyze()}><span>✦</span><div><b>{comparison ? "Analyze response changes" : "Analyze this response"}</b><small>Explain evidence, differences and next checks</small></div><i>→</i></button>
      <div className="assistant-thread">
        <div className="assistant-thread-label"><span>Analysis</span>{(streaming || agent?.status === "running") && <i>Working</i>}</div>
        {!assistantMessages.length && !streaming && <div className="assistant-placeholder"><span>✦</span><p>{analysisRequested ? "The Agent is analyzing the selected evidence." : "Request Lab works independently. Ask the Agent only when you want a second opinion."}</p></div>}
        {assistantMessages.map((message, index) => <article key={`${index}-${message.text.slice(0, 20)}`}><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}</div><MarkdownBody>{message.text}</MarkdownBody></article>)}
        {streaming && <article className="streaming"><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}<i /></div><MarkdownBody>{streaming}</MarkdownBody></article>}
      </div>
      <footer><span>Execution</span><b>Human initiated · same origin</b></footer>
    </aside>
  </section>;
}
