import { useEffect, useRef, useState } from "react";
import type { WebSearchMode, WebSearchResult, WebSearchSettings as SearchSettings } from "@kanna/shared";
import "./web-search-settings.css";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result as T;
}

export function WebSearchSettingsPanel({ onError }: { onError(message: string): void }) {
  const [settings, setSettings] = useState<SearchSettings>();
  const [deepseekKey, setDeepSeekKey] = useState("");
  const [nvdKey, setNvdKey] = useState("");
  const [clearDeepSeek, setClearDeepSeek] = useState(false);
  const [clearNvd, setClearNvd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("CVE-2024-3094");
  const [mode, setMode] = useState<WebSearchMode>("auto");
  const [result, setResult] = useState<WebSearchResult>();
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<SearchSettings>("/api/web-search/settings", { signal: controller.signal }).then(setSettings).catch((error) => { if (!controller.signal.aborted) onError(error.message); });
    return () => { controller.abort(); pending.current?.abort(); };
  }, []);
  if (!settings) return <p role="status">Loading Web Search settings…</p>;

  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setNotice("");
    try {
      setSettings(await api<SearchSettings>("/api/web-search/settings", { method: "PUT", body: JSON.stringify({ enabled: settings!.enabled, deepseekApiKey: deepseekKey || undefined, nvdApiKey: nvdKey || undefined, clearDeepSeekKey: clearDeepSeek, clearNvdKey: clearNvd }) }));
      setDeepSeekKey(""); setNvdKey(""); setClearDeepSeek(false); setClearNvd(false); setDirty(false);
      setNotice("Saved. Applies to the next search, including existing Agent Sessions.");
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  async function testSearch(event: React.FormEvent) {
    event.preventDefault();
    const controller = new AbortController(); pending.current = controller;
    setTesting(true); setResult(undefined); setNotice("");
    try { setResult(await api<WebSearchResult>("/api/web-search/test", { method: "POST", body: JSON.stringify({ query, mode, maxResults: 5 }), signal: controller.signal })); }
    catch (error) { if (controller.signal.aborted) setNotice("Search cancelled."); else onError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = null; setTesting(false); }
  }
  return <div className="web-search-settings settings-stack">
    <header className="settings-page-heading"><div><span>READ-ONLY INTERNET TOOL</span><h2>Web Search</h2><p>Let your Agent look up CVEs and search public sources with citations. Search uses a trusted API broker; command sandbox network access remains unchanged.</p></div><b>{settings.enabled ? "Enabled" : "Disabled"}</b></header>
    <section className="settings-card"><div className="settings-card-title"><div><h3>Search providers</h3><p>CVE records work without a key. Add a DeepSeek API Key to search general webpages.</p></div></div>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={saving || testing}>
          <label className="search-checkbox"><input type="checkbox" checked={settings.enabled} onChange={(event) => { setSettings({ ...settings, enabled: event.target.checked }); setDirty(true); }} />Enable Agent web_search</label>
          <label>DeepSeek API Key · general web search<input type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={deepseekKey} onChange={(event) => { setDeepSeekKey(event.target.value); setDirty(true); }} placeholder={settings.deepseekKeyConfigured ? "Key saved · leave empty to keep" : "sk-…"} /></label>
          <label className="search-checkbox"><input type="checkbox" checked={clearDeepSeek} onChange={(event) => { setClearDeepSeek(event.target.checked); setDirty(true); }} />Remove saved DeepSeek key</label>
          <label>NVD API Key · optional<input type="password" autoComplete="new-password" spellCheck={false} maxLength={512} value={nvdKey} onChange={(event) => { setNvdKey(event.target.value); setDirty(true); }} placeholder={settings.nvdKeyConfigured ? "Key saved · leave empty to keep" : "Optional · improves the NVD rate limit"} /></label>
          <label className="search-checkbox"><input type="checkbox" checked={clearNvd} onChange={(event) => { setClearNvd(event.target.checked); setDirty(true); }} />Remove saved NVD key</label>
          <p className="search-help">Keys are saved in this installation's local data directory and never returned to the Agent. This is local file storage, not an encrypted vault. Search terms are sent to NVD or DeepSeek—do not include credentials or private data. DeepSeek searches may consume your account quota.</p>
          <div className="settings-actions"><button type="submit" className="settings-primary">{saving ? "Saving…" : "Save search settings"}</button></div>
        </fieldset>
      </form>
    </section>
    <section className="settings-card"><div className="settings-card-title"><div><h3>Try a search</h3><p>Test the saved configuration directly, without an LLM request.</p></div></div>
      <form className="settings-form" onSubmit={(event) => void testSearch(event)}>
        <div className="settings-field-grid"><label>Search query<input disabled={testing} maxLength={500} required value={query} onChange={(event) => setQuery(event.target.value)} /></label><label>Source<select disabled={testing} value={mode} onChange={(event) => setMode(event.target.value as WebSearchMode)}><option value="auto">Auto</option><option value="cve">NVD / CVE</option><option value="web">Web / DeepSeek</option></select></label></div>
        <p className="search-help">Auto: exact CVE ID → NVD; other queries → DeepSeek when configured, otherwise NVD keyword search only. DeepSeek web queries support up to 128 Unicode characters. Use English product names for NVD. Agent profiles read-only/workspace/full support this tool; chat remains tool-free.</p>
        {dirty && <p className="settings-notice">Save your changed settings before testing.</p>}
        <div className="settings-actions">{testing ? <button type="button" className="settings-secondary" onClick={() => pending.current?.abort()}>Cancel search</button> : <button type="submit" className="settings-primary" disabled={saving || dirty || !settings.enabled || !query.trim() || (mode === "web" && !settings.deepseekKeyConfigured)}>Test search</button>}</div>
      </form>
      {testing && <p role="status" className="search-help">Searching… NVD requests may wait briefly for rate limits.</p>}
      {result && <div className="search-preview" aria-live="polite"><p className="search-help">{result.provider.toUpperCase()} · {result.totalResults} matches · showing {result.results.length} · {result.cached ? "cached · " : ""}{new Date(result.retrievedAt).toLocaleString()}</p>
        {!result.results.length && <p>No results. This does not prove there are no vulnerabilities.</p>}
        {result.results.map((hit, index) => <article key={`${hit.url}-${index}`}><a href={hit.url} target="_blank" rel="noopener noreferrer">{hit.title || hit.url} ↗</a>{hit.cvss && <span className="search-cvss">CVSS {hit.cvss.version} · {hit.cvss.score} {hit.cvss.severity}</span>}<p>{hit.snippet}</p><small>{hit.published && `Published: ${hit.published} `}{hit.status && `· ${hit.status}`} {hit.weaknesses?.join(" · ")}</small>{hit.references?.length ? <details><summary>Reference links</summary>{hit.references.map((ref, index) => <a key={`${ref.url}-${index}`} href={ref.url} target="_blank" rel="noopener noreferrer">{ref.tags.join(" · ") || "Source"}: {ref.url}</a>)}</details> : null}</article>)}
        <p className="search-help">{result.notice}</p>
      </div>}
    </section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
    <p className="search-help">In chat, try: “查询 CVE-2024-3094，总结漏洞影响和修复建议，并列出来源。”<br />Provider documentation: <a href="https://api-docs.deepseek.com/zh-cn/guides/search/" target="_blank" rel="noopener noreferrer">DeepSeek Search</a> · <a href="https://nvd.nist.gov/developers/vulnerabilities" target="_blank" rel="noopener noreferrer">NVD CVE API</a></p>
  </div>;
}
