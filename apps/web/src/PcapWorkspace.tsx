import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatMessage, AgentWorkspace, Project } from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import { buildOriginalCaptureDisclosure, buildPcapPreview } from "./pcap-preview.js";
import "./pcap-workspace.css";

interface Asset { address: string; names: string[]; sent: number; received: number; protocols: string[] }
interface Link { source: string; target: string; protocol: string; packets: number; bytes: number; ports: number[] }
interface Http { id: string; source: string; target: string; port: number; method: string; path: string; host: string; status?: number; contentType?: string; requestPreview?: string; responsePreview?: string; requestRaw?: string; responseRaw?: string; fileIds: string[] }
interface Credential { id: string; kind: string; source: string; target: string; username?: string; value: string; evidence: string }
interface Webshell { id: string; family: string; confidence: string; source: string; target: string; path: string; evidence: string[]; httpId: string }
interface ExportFile { id: string; name: string; mediaType: string; size: number; source: string; httpId: string }
interface Report {
  id: string; projectId: string; name: string; createdAt: number; format: string; packetCount: number; byteCount: number; captureSha256?: string;
  truncated: boolean; encryptedStreams: number; decryptedStreams?: number; decryption: { status: string; explanation: string };
  tshark?: { status: "used" | "unavailable" | "failed"; httpRecords: number };
  assets: Asset[]; links: Link[]; http: Http[]; credentials: Credential[]; webshells: Webshell[]; files: ExportFile[]; warnings: string[];
}
interface ReportSummary { id: string; name: string; createdAt: number; format: string; byteCount: number }
type View = "overview" | "graph" | "http" | "webshells" | "credentials" | "files";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function AssetGraph({ report, onSelect }: { report: Report; onSelect(selection: string): void }) {
  const nodes = report.assets.slice(0, 28);
  const positions = new Map(nodes.map((node, index) => [node.address, {
    x: 50 + 39 * Math.cos((index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2),
    y: 50 + 38 * Math.sin((index / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2),
  }]));
  const edges = report.links.filter((link) => positions.has(link.source) && positions.has(link.target)).slice(0, 80);
  return <div className="pcap-graph" role="group" aria-label="Observed communication graph">
    <svg className="pcap-graph-lines" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true">
      <defs><marker id="pcap-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 7 3.5 0 7" /></marker></defs>
      {edges.map((link, index) => {
        const a = positions.get(link.source)!; const b = positions.get(link.target)!;
        const start = { x: a.x * 10, y: a.y * 5 }; const end = { x: b.x * 10, y: b.y * 5 };
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const ux = (end.x - start.x) / length; const uy = (end.y - start.y) / length;
        const px = -uy * 8; const py = ux * 8;
        return <line key={`${link.source}-${link.target}-${index}`} x1={start.x + ux * 55 + px} y1={start.y + uy * 24 + py} x2={end.x - ux * 65 + px} y2={end.y - uy * 28 + py} markerEnd="url(#pcap-arrow)" />;
      })}
    </svg>
    {nodes.map((node) => {
      const position = positions.get(node.address)!;
      return <button className="pcap-graph-node" key={node.address} type="button" style={{ left: `${position.x}%`, top: `${position.y}%` }} onClick={() => onSelect(node.address)} title={`Inspect ${node.address}`}>
        <b>{node.names[0] ?? node.address}</b><small>{node.address}</small>
      </button>;
    })}
    {!nodes.length && <p className="pcap-graph-empty">No decoded IP communication in this capture.</p>}
  </div>;
}

export function PcapWorkspace({ project, agent, messages, streaming, onError }: {
  project?: Project; agent?: AgentWorkspace; messages: AgentChatMessage[]; streaming: string; onError(value: string): void;
}) {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [report, setReport] = useState<Report>();
  const [view, setView] = useState<View>("overview");
  const [selection, setSelection] = useState("overview");
  const [includeRaw, setIncludeRaw] = useState(false);
  const [includeOriginalCapture, setIncludeOriginalCapture] = useState(false);
  const [confirmOriginalCapture, setConfirmOriginalCapture] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [assistantBaseline, setAssistantBaseline] = useState(0);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keyLogRef = useRef<HTMLInputElement>(null);
  const reportRequest = useRef(0);

  useEffect(() => {
    const request = ++reportRequest.current;
    setReport(undefined); setReports([]); setSelection("overview"); setConfirmed(false);
    if (!project) return;
    void api<ReportSummary[]>(`/api/projects/${project.id}/pcap`).then(async (loaded) => {
      if (reportRequest.current !== request) return;
      setReports(loaded);
      if (loaded[0]) {
        const detail = await api<Report>(`/api/projects/${project.id}/pcap/${loaded[0].id}`);
        if (reportRequest.current === request) setReport(detail);
      }
    }).catch((reason) => onError(String(reason)));
    return () => { reportRequest.current++; };
  }, [project?.id]);

  async function selectReport(id: string) {
    if (!project) return;
    const request = ++reportRequest.current;
    setReport(undefined); selectEvidence("overview");
    if (!id) return;
    try {
      const detail = await api<Report>(`/api/projects/${project.id}/pcap/${id}`);
      if (reportRequest.current === request) setReport(detail);
    } catch (reason) { if (reportRequest.current === request) onError(String(reason)); }
  }

  const preview = useMemo(() => report ? [buildPcapPreview(report, selection, includeRaw),
    ...(includeOriginalCapture ? [buildOriginalCaptureDisclosure(report)] : [])].join("\n\n") : "",
  [report, selection, includeRaw, includeOriginalCapture]);
  const rawAvailable = Boolean(report?.http.some((item) => item.id === selection) || report?.credentials.some((item) => item.id === selection));
  const assistantMessages = analysisRequested ? messages.slice(assistantBaseline).filter((message) => message.role === "assistant") : [];
  const selectEvidence = (value: string) => { setSelection(value); setIncludeRaw(false); setIncludeOriginalCapture(false); setConfirmOriginalCapture(false); setConfirmed(false); };

  useEffect(() => { setIncludeOriginalCapture(false); setConfirmOriginalCapture(false); setConfirmed(false); }, [agent?.id]);

  async function importFile(file?: File) {
    if (!project || !file) return;
    if (file.size > 64 * 1024 * 1024) { onError("PCAP file exceeds the 64 MB limit"); return; }
    setBusy(true);
    try {
      const loaded = await api<Report>(`/api/projects/${project.id}/pcap`, {
        method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: await file.arrayBuffer(),
      });
      ++reportRequest.current;
      setReports((current) => [{ id: loaded.id, name: loaded.name, createdAt: loaded.createdAt, format: loaded.format, byteCount: loaded.byteCount }, ...current]);
      setReport(loaded); setView("overview"); selectEvidence("overview");
    } catch (reason) { onError(String(reason)); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  }

  async function importKeyLog(file?: File) {
    if (!project || !report || !file) return;
    if (!/\.(?:log|keys|txt)$/i.test(file.name) || file.size < 1 || file.size > 1024 * 1024) {
      onError("Choose a .log, .keys or .txt TLS key log up to 1 MiB");
      return;
    }
    setBusy(true);
    try {
      const updated = await api<Report>(`/api/projects/${project.id}/pcap/${report.id}/tls-keylog`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: await file.arrayBuffer(),
      });
      setReport(updated); selectEvidence("overview");
    } catch (reason) { onError(String(reason)); }
    finally { setBusy(false); if (keyLogRef.current) keyLogRef.current.value = ""; }
  }

  async function sendToAgent() {
    if (!project || !report || !agent || !confirmed || (includeOriginalCapture && !confirmOriginalCapture)) return;
    setBusy(true);
    try {
      setAssistantBaseline(messages.length);
      setAnalysisRequested(true);
      await api(`/api/projects/${project.id}/pcap/${report.id}/analyze`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, selection, includeRaw, confirmed: true,
          includeOriginalCapture, confirmOriginalCapture,
          mode: agent.status === "running" ? "followUp" : "prompt" }),
      });
      setConfirmed(false); setConfirmOriginalCapture(false);
    } catch (reason) { setAnalysisRequested(false); onError(String(reason)); }
    finally { setBusy(false); }
  }

  const tabs: Array<{ id: View; title: string; count?: number }> = [
    { id: "overview", title: "Overview" }, { id: "graph", title: "Asset graph", count: report?.assets.length },
    { id: "http", title: "HTTP", count: report?.http.length }, { id: "webshells", title: "WebShell clues", count: report?.webshells.length },
    { id: "credentials", title: "Credentials", count: report?.credentials.length }, { id: "files", title: "Files", count: report?.files.length },
  ];

  return <div className="pcap-workspace">
    <section className="pcap-main">
      <header className="pcap-heading">
        <div><small>OFFLINE EVIDENCE / PCAP</small><h2 className="ak-font-serif">Traffic Analysis</h2><p>Import a capture, inspect observed paths, and extract HTTP evidence.</p></div>
        <input ref={inputRef} type="file" accept=".pcap,.pcapng,.cap" hidden onChange={(event) => void importFile(event.target.files?.[0])} />
        <input ref={keyLogRef} type="file" accept=".log,.keys,.txt,text/plain" hidden onChange={(event) => void importKeyLog(event.target.files?.[0])} />
        <button className="pcap-import" type="button" disabled={!project || busy} onClick={() => inputRef.current?.click()}>{busy ? "Analyzing…" : "＋ Import PCAP"}</button>
      </header>
      <div className="pcap-capture-bar">
        <label>Capture <select aria-label="Selected PCAP capture" value={report?.id ?? ""} onChange={(event) => void selectReport(event.target.value)}><option value="">Select a capture</option>{reports.map((item) => <option value={item.id} key={item.id}>{item.name} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label>
        <span>{report ? `${report.format.toUpperCase()} · ${bytes(report.byteCount)}` : "No capture loaded"}</span>
      </div>
      {!report ? <div className="pcap-empty"><span>◇</span><h3 className="ak-font-serif">Start with a capture</h3><p>Choose a .pcap or .pcapng file from this computer. Analysis stays local until you explicitly send selected evidence to an Agent.</p><button disabled={!project || busy} onClick={() => inputRef.current?.click()}>Choose file</button></div> : <>
        <nav className="pcap-tabs" aria-label="Traffic analysis views">{tabs.map((tab) => <button type="button" key={tab.id} aria-current={view === tab.id ? "page" : undefined} className={view === tab.id ? "selected" : ""} onClick={() => setView(tab.id)}>{tab.title}{tab.count !== undefined && <span>{tab.count}</span>}</button>)}</nav>
        <div className="pcap-content">
          {view === "overview" && <>
            <div className="pcap-metrics"><article><span>PACKETS</span><b>{report.packetCount.toLocaleString()}</b></article><article><span>OBSERVED ASSETS</span><b>{report.assets.length}</b></article><article><span>HTTP TRANSACTIONS</span><b>{report.http.length}</b></article><article><span>EXPORTED OBJECTS</span><b>{report.files.length}</b></article></div>
            <div className="pcap-grid-two"><section className="pcap-panel"><h3>Decryption status</h3><p>{report.decryption.explanation}</p><strong className={report.decryption.status === "decrypted" ? "pcap-ok" : "pcap-warning"}>{report.encryptedStreams ? `${report.decryptedStreams ?? 0} / ${report.encryptedStreams} TLS directions decrypted` : "No TLS payload detected"}</strong><p className="pcap-tshark-status">{report.tshark?.status === "used" ? `Bundled TShark: ${report.tshark.httpRecords} HTTP records inspected` : report.tshark?.status === "failed" ? "Bundled TShark could not decode this capture; native parser results are shown." : "Bundled TShark unavailable; native parser results are shown."}</p><div className="pcap-keylog-actions"><button className="pcap-keylog-button" type="button" disabled={!report.encryptedStreams || busy} onClick={() => keyLogRef.current?.click()}>Import TLS key log</button><small>Processed locally; key log is not saved or sent to the Agent.</small></div></section><section className="pcap-panel"><h3>Detection summary</h3><p>{report.webshells.length ? `${report.webshells.length} candidate WebShell signal(s), each requiring review.` : "No supported WebShell clues found in decoded HTTP."}</p><button onClick={() => { setView("webshells"); selectEvidence("overview"); }}>Inspect clues →</button></section></div>
            {report.warnings.length > 0 && <section className="pcap-panel"><h3>Coverage notes</h3>{report.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
            <section className="pcap-panel"><h3>Observed communication</h3><p>Edges show source → destination seen in this capture; they do not prove intermediate network hops.</p><div className="pcap-link-list">{report.links.slice(0, 10).map((link, index) => <button key={`${link.source}-${link.target}-${index}`} onClick={() => selectEvidence(`${link.source}->${link.target}`)}><b>{link.source}</b><span>→</span><b>{link.target}</b><small>{link.protocol} · {link.packets} packets</small></button>)}</div></section>
          </>}
          {view === "graph" && <><div className="pcap-section-intro"><h3>Observed asset graph</h3><p>Click a node to prepare its evidence for the Agent. Showing up to 28 assets and 80 connections.</p></div><AssetGraph report={report} onSelect={selectEvidence} /><div className="pcap-legend">● Endpoint observed in capture <span>→ Captured source-to-destination traffic</span></div></>}
          {view === "http" && <><div className="pcap-section-intro"><h3>HTTP evidence</h3><p>Parsed HTTP/1.x conversations, including successfully decrypted TLS streams. Unreadable traffic is excluded.</p></div><div className="pcap-list">{report.http.map((item) => <button type="button" key={item.id} className={selection === item.id ? "selected" : ""} onClick={() => selectEvidence(item.id)}><span className="pcap-list-title"><b>{item.method} {item.host}{item.path}</b><em>{item.status ?? "—"}</em></span><small>{item.source} → {item.target}:{item.port} · {item.contentType ?? "unknown response type"}</small><code>{item.requestPreview || "No request body"}</code></button>)}{!report.http.length && <p className="pcap-muted">No complete supported HTTP request was found.</p>}</div></>}
          {view === "webshells" && <><div className="pcap-section-intro"><h3>WebShell candidates</h3><p>Rule based clues for Caidao, Behinder and AntSword. A family label is a hypothesis, not attribution.</p></div><div className="pcap-list">{report.webshells.map((item) => <button type="button" key={item.id} className={selection === item.id ? "selected" : ""} onClick={() => selectEvidence(item.id)}><span className="pcap-list-title"><b>{item.family} candidate</b><em>{item.confidence} confidence</em></span><small>{item.source} → {item.target} · {item.path}</small><p>{item.evidence.join(" · ")}</p></button>)}{!report.webshells.length && <p className="pcap-muted">No matching clues in decoded HTTP.</p>}</div></>}
          {view === "credentials" && <><div className="pcap-section-intro"><h3>Recoverable credentials</h3><p>Cleartext forms, FTP commands and HTTP Basic from readable or key-log-decrypted streams. Basic is Base64 encoding, not encryption.</p></div><div className="pcap-list">{report.credentials.map((item) => <button type="button" key={item.id} className={selection === item.id ? "selected" : ""} onClick={() => selectEvidence(item.id)}><span className="pcap-list-title"><b>{item.kind}</b><em>REVIEW</em></span><small>{item.username ?? "unknown user"} · {item.source} → {item.target}</small><code>Value: •••••••• · {item.evidence}</code></button>)}{!report.credentials.length && <p className="pcap-muted">No supported recoverable credentials found.</p>}</div></>}
          {view === "files" && <><div className="pcap-section-intro"><h3>Extracted HTTP objects</h3><p>Downloaded objects are treated as untrusted files and are never opened automatically.</p></div><div className="pcap-list">{report.files.map((file) => <div className="pcap-file-row" key={file.id}><div><b>{file.name}</b><small>{file.mediaType} · {bytes(file.size)} · {file.source}</small></div><button type="button" onClick={() => selectEvidence(file.id)}>Send context</button><a href={`/api/projects/${report.projectId}/pcap/${report.id}/files/${file.id}`} download={file.name}>Download ↓</a></div>)}{!report.files.length && <p className="pcap-muted">No supported HTTP object found in this capture.</p>}</div></>}
        </div>
      </>}
    </section>
    <aside className="pcap-agent" aria-label="PCAP Agent assistant">
      <header><span className="pcap-agent-mark">π</span><div><small>CONTEXT ASSISTANT</small><b>{agent?.name ?? "Choose an Agent"}</b></div><i>{agent?.status ?? "idle"}</i></header>
      <div className="pcap-agent-inner">
        <h3>Send selected evidence</h3><p>Review the exact context below before handing it to the selected Agent. Nothing is sent when you import a capture.</p>
        <label className="pcap-field">Evidence<select value={selection} onChange={(event) => selectEvidence(event.target.value)} disabled={!report}><option value="overview">Capture summary</option>{report?.assets.map((item) => <option key={item.address} value={item.address}>Asset: {item.names[0] ?? item.address}</option>)}{report?.links.map((item, index) => <option key={`${item.source}-${item.target}-${index}`} value={`${item.source}->${item.target}`}>Flow: {item.source} → {item.target}</option>)}{report?.http.map((item) => <option key={item.id} value={item.id}>{item.method} {item.path}</option>)}{report?.webshells.map((item) => <option key={item.id} value={item.id}>{item.family}: {item.path}</option>)}{report?.credentials.map((item) => <option key={item.id} value={item.id}>{item.kind}: {item.username ?? item.id}</option>)}{report?.files.map((item) => <option key={item.id} value={item.id}>File: {item.name}</option>)}</select></label>
        <label className="pcap-check"><input type="checkbox" checked={includeRaw} disabled={!rawAvailable} onChange={(event) => { setIncludeRaw(event.target.checked); setConfirmed(false); }} /><span>Include selected raw text (up to 8 KiB per HTTP body) or credential value</span></label>
        <label className="pcap-check"><input type="checkbox" checked={includeOriginalCapture} disabled={!report || !agent || agent.toolProfile === "chat" || agent.status === "running"} onChange={(event) => { setIncludeOriginalCapture(event.target.checked); setConfirmOriginalCapture(false); setConfirmed(false); }} /><span>Attach complete original PCAP (up to 64 MB; may contain credentials and private traffic)</span></label>
        {includeOriginalCapture && <label className="pcap-check pcap-original-confirm"><input type="checkbox" checked={confirmOriginalCapture} onChange={(event) => setConfirmOriginalCapture(event.target.checked)} /><span>I reviewed the filename, size and SHA-256 below and approve sharing the full binary file with this Agent.</span></label>}
        {agent?.toolProfile === "chat" && <p className="pcap-attachment-note">Choose an Agent with file-reading tools to attach the original capture.</p>}
        <label className="pcap-field">Agent preview<pre className="pcap-preview">{preview || "Select a capture to preview evidence."}</pre></label>
        <label className="pcap-check"><input type="checkbox" checked={confirmed} disabled={!report || !agent} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed this evidence and want to send it to the Agent</span></label>
        <button className="pcap-send" type="button" disabled={!project || !report || !agent || !confirmed || (includeOriginalCapture && (!confirmOriginalCapture || agent.status === "running")) || busy} onClick={() => void sendToAgent()}>{agent?.status === "running" ? "Queue for Agent →" : "Send to Agent →"}</button>
        <div className="pcap-agent-thread"><h4>Assistant response</h4>{assistantMessages.map((message, index) => <article key={index}><MarkdownBody>{message.text}</MarkdownBody></article>)}{analysisRequested && streaming && <article><MarkdownBody>{streaming}</MarkdownBody></article>}{!assistantMessages.length && !streaming && <p>{analysisRequested ? "Waiting for the Agent…" : "Responses to this capture will appear here."}</p>}</div>
      </div>
    </aside>
  </div>;
}
