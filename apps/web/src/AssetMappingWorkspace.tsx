import { useEffect, useMemo, useState } from "react";
import type {
  AgentChatMessage,
  AgentWorkspace,
  FofaAsset,
  FofaConfigPublic,
  FofaSearchResult,
} from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./asset-mapping-workspace.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

function topCounts(values: Array<string | undefined>, limit = 4): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = value?.trim() || "Unknown";
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit);
}

function assetTarget(asset: FofaAsset): string {
  return asset.link || asset.host || `${asset.ip}:${asset.port}`;
}

function safeExternalUrl(asset: FofaAsset): string | undefined {
  try {
    const url = new URL(assetTarget(asset));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const PREVIEW_ASSETS: FofaAsset[] = [
  { host: "https://portal.example.test", ip: "203.0.113.10", port: 443, protocol: "https", domain: "portal.example.test", title: "Example Portal", country: "China", city: "Shanghai", organization: "Example Lab", server: "nginx", link: "https://portal.example.test" },
  { host: "vpn.example.test", ip: "203.0.113.18", port: 443, protocol: "https", domain: "vpn.example.test", title: "Remote Access", country: "China", city: "Beijing", organization: "Example Lab", server: "Apache" },
  { host: "mail.example.test", ip: "198.51.100.24", port: 25, protocol: "smtp", domain: "mail.example.test", country: "Singapore", city: "Singapore", organization: "Example Cloud" },
  { host: "203.0.113.31", ip: "203.0.113.31", port: 22, protocol: "ssh", country: "China", city: "Shanghai", organization: "Example Lab", server: "OpenSSH" },
];

export function AssetMappingWorkspace({ agent, messages, streaming, onError }: {
  agent?: AgentWorkspace;
  messages: AgentChatMessage[];
  streaming: string;
  onError(value: string): void;
}) {
  const [config, setConfig] = useState<FofaConfigPublic>();
  const [configOpen, setConfigOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(100);
  const [full, setFull] = useState(false);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<FofaSearchResult>();
  const [assets, setAssets] = useState<FofaAsset[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [assistantBaseline, setAssistantBaseline] = useState(0);

  useEffect(() => {
    void api<FofaConfigPublic>("/api/fofa/config")
      .then((loaded) => { setConfig(loaded); if (!loaded.configured) setConfigOpen(true); })
      .catch((reason) => onError(String(reason)));
  }, []);

  const selected = assets[selectedIndex];
  const uniqueIps = useMemo(() => new Set(assets.map((asset) => asset.ip).filter(Boolean)).size, [assets]);
  const protocols = useMemo(() => topCounts(assets.map((asset) => asset.protocol)), [assets]);
  const countries = useMemo(() => topCounts(assets.map((asset) => asset.country)), [assets]);
  const organizations = useMemo(() => topCounts(assets.map((asset) => asset.organization)), [assets]);
  const assistantAll = useMemo(() => messages.filter((message) => message.role === "assistant"), [messages]);
  const assistantMessages = analysisRequested ? assistantAll.slice(assistantBaseline).slice(-2) : [];
  const analysisComplete = analysisRequested && assistantMessages.length > 0 && !streaming && agent?.status !== "running";

  async function saveConfig() {
    if (!apiKey.trim()) return;
    setSavingConfig(true);
    try {
      const saved = await api<FofaConfigPublic>("/api/fofa/config", {
        method: "POST",
        body: JSON.stringify({ apiKey }),
      });
      setConfig(saved);
      setApiKey("");
      setConfigOpen(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingConfig(false);
    }
  }

  async function search(next?: string, append = false) {
    if (!query.trim() || searching) return;
    setSearching(true);
    setPreview(false);
    try {
      const loaded = await api<FofaSearchResult>("/api/fofa/search", {
        method: "POST",
        body: JSON.stringify({ query, size: pageSize, full, next }),
      });
      setResult(loaded);
      setAssets((current) => append ? [...current, ...loaded.assets] : loaded.assets);
      setSelectedIndex(append ? selectedIndex : 0);
      setAnalysisRequested(false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearching(false);
    }
  }

  function loadPreview() {
    setPreview(true);
    setQuery('domain="example.test"');
    setAssets(PREVIEW_ASSETS);
    setSelectedIndex(0);
    setResult({ query: 'domain="example.test"', total: 4, page: 1, assets: PREVIEW_ASSETS });
  }

  async function askAgent() {
    if (!agent || !assets.length) return;
    setAssistantBaseline(assistantAll.length);
    setAnalysisRequested(true);
    try {
      await api("/api/fofa/analyze", {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.id,
          query: result?.query || query,
          assets,
          mode: agent.status === "running" ? "followUp" : "prompt",
        }),
      });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <section className={`asset-map-workspace ${assistantOpen ? "" : "assistant-closed"}`}>
    <div className="asset-map-main">
      <header className="asset-searchbar">
        <div className="asset-source"><span>F</span><div><b>FOFA Asset Mapping</b><small>{config?.configured ? "API connected" : "API configuration required"}</small></div></div>
        <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <input aria-label="FOFA query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={'domain="example.com" && country="CN"'} />
          <button disabled={!config?.configured || !query.trim() || searching}>{searching ? "Searching…" : "Search FOFA →"}</button>
        </form>
        <button className="asset-settings" onClick={() => setConfigOpen(true)}>⚙ API</button>
      </header>

      <div className="asset-options">
        <div><span className={`api-state ${config?.configured ? "connected" : ""}`}><i />{config?.configured ? "FOFA ready" : "FOFA not configured"}</span><span className={preview ? "preview-label active" : "preview-label"}>{preview ? "DEMO DATA" : "LIVE DATA"}</span></div>
        <label>Per request<select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}><option value={50}>50</option><option value={100}>100</option><option value={500}>500</option><option value={1000}>1000</option></select></label>
        <label className="asset-full"><input type="checkbox" checked={full} onChange={(event) => setFull(event.target.checked)} /><span>Full history</span></label>
        <button onClick={() => setAssistantOpen((current) => !current)}>{assistantOpen ? "Hide assistant" : "Open Agent assistant"}</button>
      </div>

      {!assets.length ? <div className="asset-map-empty">
        <div className="asset-map-mark">◎</div><h2>Map an authorized internet-facing asset set</h2><p>Configure a FOFA API Key, enter FOFA syntax, and review services, regions and organizations without leaving KannaPi.</p>
        <div><button className="asset-configure" onClick={() => setConfigOpen(true)}>{config?.configured ? "Update FOFA API Key" : "Configure FOFA API"}</button><button onClick={loadPreview}>Load safe UI preview</button></div>
        <small>Passive search only. Query assets you own or are authorized to assess.</small>
      </div> : <>
        <div className="asset-metrics">
          <article><span>Matched by FOFA</span><b>{(result?.total ?? assets.length).toLocaleString()}</b><small>{assets.length.toLocaleString()} loaded</small></article>
          <article><span>Unique IPs</span><b>{uniqueIps.toLocaleString()}</b><small>{Math.max(assets.length - uniqueIps, 0)} shared hosts</small></article>
          <article><span>Top protocol</span><b>{protocols[0]?.[0] ?? "—"}</b><small>{protocols[0]?.[1] ?? 0} visible assets</small></article>
          <article><span>Countries</span><b>{countries.length}</b><small>{countries.map(([name]) => name).slice(0, 2).join(" · ") || "No location"}</small></article>
        </div>

        <div className="asset-map-content">
          <section className="asset-results">
            <header><div><b>Discovered assets</b><small>{result?.query}</small></div><span>{preview ? "Preview" : `Page ${result?.page ?? 1}`}</span></header>
            <div className="asset-table-head"><span>Host</span><span>IP / Port</span><span>Service</span><span>Location</span></div>
            <div className="asset-table-body">{assets.map((asset, index) => <button key={`${asset.host}-${asset.ip}-${asset.port}-${index}`} className={index === selectedIndex ? "selected" : ""} onClick={() => setSelectedIndex(index)}>
              <span className="asset-host"><b>{asset.host || asset.domain || asset.ip}</b><small>{asset.title || asset.domain || "Untitled asset"}</small></span>
              <span><b>{asset.ip}</b><small>:{asset.port}</small></span>
              <span><i>{asset.protocol || "unknown"}</i><small>{asset.server || "—"}</small></span>
              <span><b>{asset.country || "Unknown"}</b><small>{[asset.region, asset.city].filter(Boolean).join(" / ") || "—"}</small></span>
            </button>)}</div>
            <footer><span>{assets.length} assets loaded{result?.consumedFPoints != null ? ` · ${result.consumedFPoints} F points` : ""}</span>{result?.next && !preview ? <button disabled={searching} onClick={() => void search(result.next, true)}>{searching ? "Loading…" : "Load next page"}</button> : <span>End of current result set</span>}</footer>
          </section>

          <aside className="asset-detail">
            <header><span>Selected asset</span><i>{selected?.protocol || "unknown"}</i></header>
            {selected && <><h2>{selected.domain || selected.host || selected.ip}</h2><p>{selected.title || "No title returned by FOFA"}</p><dl><div><dt>Address</dt><dd>{selected.ip}:{selected.port}</dd></div><div><dt>Protocol</dt><dd>{selected.protocol || "—"}</dd></div><div><dt>Server</dt><dd>{selected.server || "—"}</dd></div><div><dt>Organization</dt><dd>{selected.organization || "—"}</dd></div><div><dt>Location</dt><dd>{[selected.country, selected.region, selected.city].filter(Boolean).join(" / ") || "—"}</dd></div></dl>{safeExternalUrl(selected) && <a href={safeExternalUrl(selected)} target="_blank" rel="noreferrer">Open asset URL ↗</a>}</>}
            <section><h3>Exposure distribution</h3><div className="asset-bars">{protocols.map(([name, count]) => <div key={name}><span><b>{name}</b><i>{count}</i></span><em style={{ width: `${Math.max(8, count / Math.max(protocols[0]?.[1] ?? 1, 1) * 100)}%` }} /></div>)}</div></section>
            <section><h3>Top organizations</h3>{organizations.map(([name, count]) => <p className="asset-org" key={name}><span>{name}</span><b>{count}</b></p>)}</section>
          </aside>
        </div>
      </>}
    </div>

    <aside className="asset-agent">
      <header><div className="agent-orb">π</div><div><span>Optional assistant</span><b>{agent?.name ?? "No Agent selected"}</b></div>{agent && <i className={`agent-state ${agent.status}`}>{agent.status}</i>}<button aria-label="Hide Agent assistant" onClick={() => setAssistantOpen(false)}>×</button></header>
      <div className="asset-agent-context"><span>Attached result set</span>{assets.length ? <><b>{result?.query || query}</b><p>{assets.length} loaded assets · {uniqueIps} unique IPs · {protocols.length} protocols</p><small>FOFA results are untrusted passive evidence. No active probing is requested.</small></> : <p>Run a FOFA search or load the safe preview first.</p>}</div>
      <button className="asset-analyze" disabled={!agent || !assets.length || preview || agent.status === "running" || (analysisRequested && !analysisComplete)} onClick={() => void askAgent()}><span>✦</span><div><b>{preview ? "Agent disabled for demo data" : !agent ? "Agent analysis is optional" : analysisComplete ? "Analyze exposure again" : analysisRequested ? "Analysis requested" : "Analyze this asset set"}</b><small>Summarize clusters, exposure and next queries</small></div><i>→</i></button>
      <div className="asset-agent-thread"><div className="asset-thread-label"><span>Exposure analysis</span>{(streaming || agent?.status === "running") && <i>Working</i>}</div>{!assistantMessages.length && !streaming && <div className="asset-agent-placeholder"><span>◎</span><p>The workspace works independently. Call Pi only when you want a second-pass summary.</p></div>}{assistantMessages.map((message, index) => <article key={`${index}-${message.text.slice(0, 20)}`}><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}</div><MarkdownBody>{message.text}</MarkdownBody></article>)}{streaming && <article><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}<i /></div><MarkdownBody>{streaming}</MarkdownBody></article>}</div>
      <footer><span>Source</span><b>{preview ? "Inert UI preview" : "FOFA passive search"}</b></footer>
    </aside>

    {configOpen && <div className="asset-config-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setConfigOpen(false); }}><section className="asset-config-dialog" role="dialog" aria-modal="true" aria-labelledby="fofa-config-title"><header><div><span>F</span><div><h2 id="fofa-config-title">Connect FOFA API</h2><p>The key stays in the local KannaPi server.</p></div></div><button aria-label="Close FOFA settings" onClick={() => setConfigOpen(false)}>×</button></header><div className="fofa-endpoint"><span>Endpoint</span><code>{config?.endpoint ?? "https://fofa.info/api/v1/search/next"}</code></div><label>FOFA API Key<input type="password" autoFocus value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config?.configured ? "Enter a new key to replace the saved key" : "Paste your FOFA API Key"} onKeyDown={(event) => { if (event.key === "Enter") void saveConfig(); }} /></label><p className="fofa-config-note">Stored in a permission-restricted local file and never returned to the browser. You can also set <code>FOFA_API_KEY</code> before starting KannaPi.</p><footer><button onClick={() => setConfigOpen(false)}>{config?.configured ? "Cancel" : "Use preview first"}</button><button className="fofa-save" disabled={!apiKey.trim() || savingConfig} onClick={() => void saveConfig()}>{savingConfig ? "Saving…" : "Save API Key"}</button></footer></section></div>}
  </section>;
}
