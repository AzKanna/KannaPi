import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCapabilities,
  AgentMcpServer,
  AgentPluginCapability,
  AgentSkillCapability,
  AgentWorkspace,
  ThinkingLevel,
} from "@kanna/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ThinkingLevelSlider } from "./ThinkingLevelSlider.js";
import { RuntimeSettingsPanel } from "./RuntimeControls.js";
import { WebSearchSettingsPanel } from "./WebSearchSettings.js";
import "./settings-workspace.css";
import "./appearance-settings.css";
import "./settings-thinking.css";
import "./settings-capability-upload.css";

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

interface DiscoveredModel {
  id: string;
  name: string;
  ownedBy?: string;
}

type SettingsSection = "llm" | "mcp" | "skills" | "plugins" | "appearance" | "runtime" | "web-search";
type ThemeMode = "light" | "dark";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export function SettingsWorkspace({
  current,
  agent,
  capabilities,
  uiScale,
  onUiScaleChange,
  theme,
  onThemeChange,
  onModelSaved,
  onCapabilitiesChanged,
  onError,
}: {
  current: ModelConfig;
  agent?: AgentWorkspace;
  capabilities: AgentCapabilities;
  uiScale: number;
  onUiScaleChange(value: number): void;
  theme: ThemeMode;
  onThemeChange(value: ThemeMode): void;
  onModelSaved(value: ModelConfig, models: ModelOption[]): void;
  onCapabilitiesChanged(value: AgentCapabilities): void;
  onError(value: string): void;
}) {
  const [section, setSection] = useState<SettingsSection>("llm");
  const reduceMotion = useReducedMotion();
  const sections: Array<{ id: SettingsSection; icon: string; title: string; detail: string; badge?: string }> = [
    { id: "llm", icon: "◈", title: "LLM & Models", detail: "Provider, key and model discovery", badge: current.configured ? "Ready" : "Setup" },
    { id: "mcp", icon: "⌘", title: "MCP Servers", detail: "Local, HTTP and SSE tools", badge: String(capabilities.mcpServers.length) },
    { id: "skills", icon: "◇", title: "Skills", detail: "Agent instruction packages", badge: String(capabilities.skills.length) },
    { id: "plugins", icon: "✧", title: "Pi Plugins", detail: "Trusted Pi extensions", badge: String(capabilities.plugins.length) },
    { id: "appearance", icon: "Aa", title: "Appearance", detail: "Color theme and interface scale", badge: theme === "dark" ? "Night" : "Day" },
    { id: "runtime", icon: "◈", title: "Execution & Context", detail: "Sandbox, subagents and compression", badge: "Local" },
    { id: "web-search", icon: "◎", title: "Web Search", detail: "CVE lookup and public web sources", badge: "API" },
  ];

  return <section className="settings-workspace">
    <nav className="settings-nav" aria-label="Settings sections">
      <div className="settings-nav-heading"><span>Configuration</span><small>LOCAL WORKSPACE</small></div>
      {sections.map((item) => <button key={item.id} type="button" className={section === item.id ? "selected" : ""} aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
        <span className="settings-nav-icon" aria-hidden="true">{item.icon}</span>
        <span><b>{item.title}</b><small>{item.detail}</small></span>
        <em>{item.badge}</em>
      </button>)}
      <div className="settings-scope">
        <span>Agent scope</span>
        <b>{agent?.name ?? "No Agent selected"}</b>
        <p>MCP servers, Skills and Plugins belong to the selected Agent. LLM and Web Search settings are shared by this local KannaPi installation.</p>
      </div>
    </nav>
    <div className="settings-content">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          className="settings-page"
          key={section}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
          transition={{ duration: reduceMotion ? 0.08 : 0.18, ease: [0.22, 1, 0.36, 1] }}
        >
          {section === "web-search" ? <WebSearchSettingsPanel onError={onError} /> : section === "runtime" ? <RuntimeSettingsPanel onError={onError} /> : section === "llm" ? <ModelSettings current={current} onSaved={onModelSaved} onError={onError} /> : section === "mcp" ? <McpSettings agent={agent} servers={capabilities.mcpServers} skills={capabilities.skills} plugins={capabilities.plugins} onChanged={onCapabilitiesChanged} onError={onError} /> : section === "skills" ? <SkillSettings agent={agent} skills={capabilities.skills} servers={capabilities.mcpServers} plugins={capabilities.plugins} onChanged={onCapabilitiesChanged} onError={onError} /> : section === "plugins" ? <PluginSettings agent={agent} capabilities={capabilities} onChanged={onCapabilitiesChanged} onError={onError} /> : <AppearanceSettings scale={uiScale} onChange={onUiScaleChange} theme={theme} onThemeChange={onThemeChange} />}
        </motion.div>
      </AnimatePresence>
    </div>
  </section>;
}

function PageHeading({ eyebrow, title, body, status }: { eyebrow: string; title: string; body: string; status?: string }) {
  return <header className="settings-page-heading"><div><span>{eyebrow}</span><h2 className="ak-font-serif">{title}</h2><p>{body}</p></div>{status && <b>{status}</b>}</header>;
}

function ModelSettings({ current, onSaved, onError }: { current: ModelConfig; onSaved(value: ModelConfig, models: ModelOption[]): void; onError(value: string): void }) {
  const [providerId, setProviderId] = useState(current.providerId ?? "openai-compatible");
  const [providerName, setProviderName] = useState(current.providerName ?? "OpenAI Compatible");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl ?? "https://api.openai.com/v1");
  const [modelId, setModelId] = useState(current.modelId ?? "");
  const [modelName, setModelName] = useState(current.modelName ?? "");
  const [apiKey, setApiKey] = useState("");
  const [contextWindow, setContextWindow] = useState(current.contextWindow ?? 128000);
  const [maxTokens, setMaxTokens] = useState(current.maxTokens ?? 8192);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(current.thinkingLevel ?? (current.reasoning ? "medium" : "off"));
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const savedKeyAvailable = current.keyConfigured && providerId === current.providerId;
  const isDeepSeek = /deepseek/i.test(`${providerId} ${modelId} ${baseUrl}`);
  const deepSeekLevels: ThinkingLevel[] = ["off", "low", "high", "max"];
  const effectiveThinkingLevel: ThinkingLevel = isDeepSeek && !deepSeekLevels.includes(thinkingLevel)
    ? thinkingLevel === "minimal" ? "low" : "high"
    : thinkingLevel;

  useEffect(() => {
    setProviderId(current.providerId ?? "openai-compatible");
    setProviderName(current.providerName ?? "OpenAI Compatible");
    setBaseUrl(current.baseUrl ?? "https://api.openai.com/v1");
    setModelId(current.modelId ?? "");
    setModelName(current.modelName ?? "");
    setContextWindow(current.contextWindow ?? 128000);
    setMaxTokens(current.maxTokens ?? 8192);
    setThinkingLevel(current.thinkingLevel ?? (current.reasoning ? "medium" : "off"));
  }, [current]);

  const selectedDiscovery = discovered.find((item) => item.id === modelId);

  async function discoverModels() {
    setDiscovering(true);
    setNotice(undefined);
    try {
      const found = await api<DiscoveredModel[]>("/api/model-config/discover", {
        method: "POST",
        body: JSON.stringify({ providerId, baseUrl, apiKey: apiKey || undefined }),
      });
      setDiscovered(found);
      if (found.length) {
        const selected = found.find((item) => item.id === modelId) ?? found[0];
        if (selected) {
          setModelId(selected.id);
          setModelName(selected.name);
        }
      }
      setNotice(found.length ? `Found ${found.length} models. Choose one, then save the connection.` : "The endpoint returned no usable models. You can still enter a model ID manually.");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDiscovering(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice(undefined);
    try {
      const saved = await api<ModelConfig>("/api/model-config", {
        method: "POST",
        body: JSON.stringify({ providerId, providerName, baseUrl, modelId, modelName: modelName || modelId, apiKey: apiKey || undefined, contextWindow, maxTokens, reasoning: effectiveThinkingLevel !== "off", thinkingLevel: effectiveThinkingLevel }),
      });
      const models = await api<ModelOption[]>("/api/models");
      setApiKey("");
      setNotice("Model connection saved locally.");
      onSaved(saved, models);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setNotice(undefined);
    try {
      const result = await api<{ ok: true; latencyMs: number; preview: string }>("/api/model-config/test", { method: "POST", body: "{}" });
      setNotice(`Connected in ${result.latencyMs} ms — ${result.preview}`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  }

  return <>
    <PageHeading eyebrow="LLM CONNECTION" title="Models and provider" body="Connect any OpenAI-compatible endpoint. KannaPi can read its model catalog so you do not have to guess model IDs." status={current.configured ? "CONNECTED" : "NOT CONFIGURED"} />
    <form className="settings-card settings-form" onSubmit={(event) => void save(event)}>
      <div className="settings-card-title"><div><h3>Provider connection</h3><p>The API key is stored only in the local Pi auth file and is never returned to this page.</p></div><span className={`settings-health ${savedKeyAvailable ? "ok" : "warning"}`}>{savedKeyAvailable ? "KEY SAVED" : "KEY REQUIRED"}</span></div>
      <div className="settings-field-grid">
        <label>Provider ID<input value={providerId} onChange={(event) => setProviderId(event.target.value)} required /></label>
        <label>Display name<input value={providerName} onChange={(event) => setProviderName(event.target.value)} required /></label>
      </div>
      <label>OpenAI-compatible base URL<div className="settings-inline-control"><input type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setDiscovered([]); }} placeholder="https://api.example.com/v1" required /><button className="settings-secondary" type="button" disabled={discovering || !baseUrl || (!apiKey && !savedKeyAvailable)} onClick={() => void discoverModels()}>{discovering ? "Discovering…" : "Discover models"}</button></div></label>
      <label>API key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={savedKeyAvailable ? "Leave blank to reuse the saved key" : "Required for discovery and requests"} required={!savedKeyAvailable} /></label>

      <div className="settings-model-picker">
        <div><span>Model catalog</span><b>{discovered.length ? `${discovered.length} discovered` : "Manual entry available"}</b></div>
        {discovered.length > 0 && <label>Available model<select value={modelId} onChange={(event) => { const selected = discovered.find((item) => item.id === event.target.value); setModelId(event.target.value); setModelName(selected?.name ?? event.target.value); }}><option value="">Choose a model</option>{discovered.map((item) => <option value={item.id} key={item.id}>{item.name}{item.ownedBy ? ` · ${item.ownedBy}` : ""}</option>)}</select></label>}
        <div className="settings-field-grid">
          <label>Model ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="gpt-4.1-mini" required /></label>
          <label>Model name<input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder={selectedDiscovery?.name ?? "Shown in the UI"} /></label>
        </div>
      </div>
      <div className="settings-thinking-control">
        <ThinkingLevelSlider value={effectiveThinkingLevel} levels={isDeepSeek ? deepSeekLevels : undefined} onChange={setThinkingLevel} />
        <p>{isDeepSeek ? "DeepSeek supports Off, Low, High and Max. This becomes the default for new Agents; change an existing Agent beside Send." : "The selected level becomes the default for new Agents. You can override it beside Send for each Agent."}</p>
      </div>
      <details className="settings-advanced"><summary>Advanced model limits</summary><div className="settings-field-grid"><label>Context window<input type="number" min="1024" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></label><label>Max output tokens<input type="number" min="256" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></label></div></details>
      {notice && <p className="settings-notice" role="status">{notice}</p>}
      <div className="settings-actions"><button className="settings-secondary" type="button" disabled={!current.configured || !current.keyConfigured || testing} onClick={() => void testConnection()}>{testing ? "Testing…" : "Test saved connection"}</button><button className="settings-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save connection"}</button></div>
    </form>
  </>;
}

function McpSettings({ agent, servers, skills, plugins, onChanged, onError }: { agent?: AgentWorkspace; servers: AgentMcpServer[]; skills: AgentSkillCapability[]; plugins: AgentPluginCapability[]; onChanged(value: AgentCapabilities): void; onError(value: string): void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const toolCount = useMemo(() => servers.reduce((count, server) => count + server.toolNames.length, 0), [servers]);

  function environment(): Record<string, string> {
    return Object.fromEntries(envText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) throw new Error(`Invalid environment line: ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1)];
    }));
  }

  async function addServer(event: React.FormEvent) {
    event.preventDefault();
    if (!agent) return;
    setBusy(true);
    try {
      const added = await api<AgentMcpServer>(`/api/agents/${agent.id}/mcp-servers`, { method: "POST", body: JSON.stringify({ name, transport, command: transport === "stdio" ? command : undefined, args: transport === "stdio" ? argsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [], url: transport !== "stdio" ? url : undefined, env: transport === "stdio" ? environment() : {} }) });
      onChanged({ skills, mcpServers: [...servers, added], plugins });
      setName(""); setCommand(""); setArgsText(""); setUrl(""); setEnvText("");
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function testServer(id: string) {
    if (!agent) return;
    setBusy(true);
    try {
      const tested = await api<AgentMcpServer>(`/api/agents/${agent.id}/mcp-servers/${id}/test`, { method: "POST", body: "{}" });
      onChanged({ skills, mcpServers: servers.map((server) => server.id === id ? tested : server), plugins });
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function removeServer(id: string) {
    if (!agent) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/mcp-servers/${id}`, { method: "DELETE" });
      onChanged({ skills, mcpServers: servers.filter((server) => server.id !== id), plugins });
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="TOOL PROTOCOL" title="MCP servers" body="Add local stdio processes, Streamable HTTP services, or legacy SSE integrations such as Burp Suite." status={`${toolCount} TOOLS`} />
    {!agent ? <AgentRequired /> : <div className="settings-stack">
      <section className="settings-card"><div className="settings-card-title"><div><h3>Connected servers</h3><p>Configurations and discovered tools apply only to {agent.name}.</p></div><span>{servers.length} SERVERS</span></div>
        <div className="settings-server-list">{servers.map((server) => <article className={`settings-server ${server.lastError ? "has-error" : ""}`} key={server.id}><div className="settings-server-icon">{server.transport === "stdio" ? ">_" : server.transport === "sse" ? "S" : "H"}</div><div className="settings-server-body"><header><div><h4>{server.name}</h4><p title={server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}>{server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}</p></div><span>{server.lastError ? "UNAVAILABLE" : `${server.toolNames.length} TOOLS`}</span></header>{server.toolNames.length > 0 && <div className="settings-tool-chips">{server.toolNames.map((tool) => <code key={tool}>{tool}</code>)}</div>}{server.envKeys.length > 0 && <small>Environment keys: {server.envKeys.join(", ")} · values hidden</small>}{server.lastError && <p className="settings-error">{server.lastError}</p>}<footer><button type="button" disabled={busy} onClick={() => void testServer(server.id)}>Test connection</button><button className="danger" type="button" disabled={busy} onClick={() => void removeServer(server.id)}>Remove</button></footer></div></article>)}{!servers.length && <EmptyCapability icon="⌘" title="No MCP servers yet" body="Add a server below to expose its tools to the selected Agent." />}</div>
      </section>
      <form className="settings-card settings-form" onSubmit={(event) => void addServer(event)}><div className="settings-card-title"><div><h3>Add MCP server</h3><p>The connection is tested while it is added, so discovered tools appear immediately.</p></div></div>
        <div className="settings-field-grid"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="burp-suite" required /></label><label>Transport<select value={transport} onChange={(event) => setTransport(event.target.value as "stdio" | "http" | "sse")}><option value="stdio">Local stdio</option><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE (Burp)</option></select></label></div>
        {transport === "stdio" ? <><label>Command<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" required /></label><div className="settings-field-grid"><label>Arguments · one per line<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nF:\\workspace'} /></label><label>Environment · KEY=value<textarea value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder="API_KEY=…" /></label></div></> : <label>Endpoint URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={transport === "sse" ? "http://127.0.0.1:9876" : "http://127.0.0.1:3000/mcp"} required /></label>}
        <div className="settings-actions single"><button className="settings-primary" disabled={busy}>{busy ? "Adding & testing…" : "Add & test server"}</button></div>
      </form>
    </div>}
  </>;
}

function SkillSettings({ agent, skills, servers, plugins, onChanged, onError }: { agent?: AgentWorkspace; skills: AgentSkillCapability[]; servers: AgentMcpServer[]; plugins: AgentPluginCapability[]; onChanged(value: AgentCapabilities): void; onError(value: string): void }) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);

  async function addSkill(event: React.FormEvent) {
    event.preventDefault();
    if (!agent || !file) return;
    setBusy(true);
    try {
      const added = await api<AgentSkillCapability>(`/api/agents/${agent.id}/skills/upload`, { method: "POST", body: JSON.stringify({ filename: file.name, content: await file.text() }) });
      onChanged({ skills: [...skills, added], mcpServers: servers, plugins });
      setFile(undefined);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function removeSkill(id: string) {
    if (!agent) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/skills/${id}`, { method: "DELETE" });
      onChanged({ skills: skills.filter((skill) => skill.id !== id), mcpServers: servers, plugins });
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const nameCount = skills.reduce((count, skill) => count + skill.names.length, 0);
  return <>
    <PageHeading eyebrow="AGENT KNOWLEDGE" title="Skills" body="Attach reusable SKILL.md instruction packages. Pi indexes them and loads matching guidance only when needed." status={`${nameCount} SKILLS`} />
    {!agent ? <AgentRequired /> : <div className="settings-stack"><section className="settings-card"><div className="settings-card-title"><div><h3>Attached Skills</h3><p>These instruction packages are available to {agent.name}.</p></div></div><div className="settings-skill-grid">{skills.map((skill) => <article className="settings-skill" key={skill.id}><span>◇</span><div><h4>{skill.names.join(", ")}</h4><p title={skill.path}>{skill.path}</p></div><button type="button" disabled={busy} onClick={() => void removeSkill(skill.id)}>Remove</button></article>)}{!skills.length && <EmptyCapability icon="◇" title="No Skills attached" body="Choose a SKILL.md file below to get started." />}</div></section>
      <form className="settings-card settings-form" onSubmit={(event) => void addSkill(event)}><div className="settings-card-title"><div><h3>Upload Skill</h3><p>Select one SKILL.md file. KannaPi stores its own copy for this Agent.</p></div></div><CapabilityFileDrop file={file} accept=".md,text/markdown" hint="Drop or click to select SKILL.md" onPick={(selected) => { if (selected.name.toLowerCase() !== "skill.md" || selected.size > 128 * 1024) { onError("Select a SKILL.md file no larger than 128 KiB"); return; } setFile(selected); }} /><p className="settings-capability-help">The file needs Pi Skill frontmatter with a name and description. References to sibling files are not included in this single-file upload.</p><div className="settings-actions single"><button className="settings-primary" disabled={busy || !file}>{busy ? "Uploading…" : "Upload Skill"}</button></div></form>
    </div>}
  </>;
}

function PluginSettings({ agent, capabilities, onChanged, onError }: { agent?: AgentWorkspace; capabilities: AgentCapabilities; onChanged(value: AgentCapabilities): void; onError(value: string): void }) {
  const [file, setFile] = useState<File>();
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!agent || !file || !trusted) return;
    setBusy(true);
    try {
      const added = await api<AgentPluginCapability>(`/api/agents/${agent.id}/plugins`, { method: "POST", body: JSON.stringify({ filename: file.name, content: await file.text(), trusted }) });
      onChanged({ ...capabilities, plugins: [...capabilities.plugins, added] });
      setFile(undefined); setTrusted(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function update(plugin: AgentPluginCapability, remove = false) {
    if (!agent) return;
    setBusy(true);
    try {
      if (remove) {
        await api(`/api/agents/${agent.id}/plugins/${plugin.id}`, { method: "DELETE" });
        onChanged({ ...capabilities, plugins: capabilities.plugins.filter((item) => item.id !== plugin.id) });
      } else {
        const saved = await api<AgentPluginCapability>(`/api/agents/${agent.id}/plugins/${plugin.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !plugin.enabled }) });
        onChanged({ ...capabilities, plugins: capabilities.plugins.map((item) => item.id === plugin.id ? saved : item) });
      }
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="PI EXTENSIONS" title="Pi Plugins" body="Attach an explicitly trusted Pi extension to one Agent. Plugins can register tools and lifecycle hooks." status={`${capabilities.plugins.length} PLUGINS`} />
    {!agent ? <AgentRequired /> : <div className="settings-stack">
      <section className="settings-card"><div className="settings-card-title"><div><h3>Installed Plugins</h3><p>Changes take effect when this Agent's next session is loaded.</p></div></div><div className="settings-skill-grid">{capabilities.plugins.map((plugin) => <article className="settings-skill" key={plugin.id}><span>✧</span><div><h4>{plugin.name}</h4><p>{plugin.enabled ? "Enabled · requires Full profile and sandbox off" : "Disabled"}</p></div><button type="button" disabled={busy} onClick={() => void update(plugin)}>{plugin.enabled ? "Disable" : "Enable"}</button><button type="button" disabled={busy} onClick={() => void update(plugin, true)}>Remove</button></article>)}{!capabilities.plugins.length && <EmptyCapability icon="✧" title="No Pi Plugins" body="Upload a trusted extension file to add tools or hooks." />}</div></section>
      <form className="settings-card settings-form" onSubmit={(event) => void upload(event)}><div className="settings-card-title"><div><h3>Upload Pi Plugin</h3><p>Use a self-contained .ts, .js or .mjs file exporting a Pi ExtensionFactory.</p></div></div><CapabilityFileDrop file={file} accept=".ts,.js,.mjs" hint="Drop or click to select a Pi extension" onPick={(selected) => { if (!/\.(ts|js|mjs)$/i.test(selected.name) || selected.size > 256 * 1024) { onError("Select a .ts, .js or .mjs file no larger than 256 KiB"); return; } setFile(selected); }} /><p className="settings-capability-warning">Plugins execute JavaScript with the application's host permissions. They do not run inside the Agent tool sandbox and can bypass tool-profile restrictions. KannaPi loads them only for Full agents when sandbox execution is disabled. Review the source before enabling.</p><label className="settings-capability-consent"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />I have reviewed and trust this Plugin's source code.</label><div className="settings-actions single"><button className="settings-primary" disabled={busy || !file || !trusted}>{busy ? "Uploading…" : "Upload Plugin"}</button></div></form>
    </div>}
  </>;
}

function CapabilityFileDrop({ file, accept, hint, onPick }: { file?: File; accept: string; hint: string; onPick(file: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return <div className={`settings-capability-drop${dragging ? " is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const selected = event.dataTransfer.files[0]; if (selected) onPick(selected); }}>
    <input ref={input} type="file" accept={accept} aria-label={hint} tabIndex={-1} onChange={(event) => { const selected = event.target.files?.[0]; if (selected) onPick(selected); event.target.value = ""; }} />
    <button type="button" onClick={() => input.current?.click()}><span aria-hidden="true">⇧</span><b>{file ? file.name : hint}</b><small>{file ? `${Math.ceil(file.size / 1024)} KiB selected` : "One file · click to browse or drag it here"}</small></button>
  </div>;
}

const SCALE_PRESETS = [80, 90, 100, 110, 125, 140];

function AppearanceSettings({ scale, onChange, theme, onThemeChange }: { scale: number; onChange(value: number): void; theme: ThemeMode; onThemeChange(value: ThemeMode): void }) {
  return <>
    <PageHeading eyebrow="DISPLAY" title="Appearance" body="Choose a comfortable color theme and resize the entire KannaPi workspace for your screen." status={theme === "dark" ? "NIGHT" : "DAY"} />
    <section className="settings-card appearance-theme-card">
      <div className="settings-card-title"><div><h3>Color theme</h3><p>Switch the whole workspace between day and night colors. Your choice is saved on this computer.</p></div></div>
      <div className="theme-options" role="group" aria-label="Color theme">
        <button type="button" className={theme === "light" ? "selected" : ""} aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}><span className="theme-swatch theme-swatch-light"><i /><i /></span><b>Day</b><small>Light workspace</small></button>
        <button type="button" className={theme === "dark" ? "selected" : ""} aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}><span className="theme-swatch theme-swatch-dark"><i /><i /></span><b>Night</b><small>Low-glare workspace</small></button>
      </div>
    </section>
    <section className="settings-card appearance-card">
      <div className="settings-card-title"><div><h3>Workspace zoom</h3><p id="ui-scale-help">Changes apply immediately and are remembered on this computer. The safe desktop range keeps navigation available at every supported window size.</p></div><output className="scale-output" htmlFor="ui-scale" aria-live="polite">{scale}%</output></div>
      <div className="scale-preview" aria-hidden="true"><span className="scale-preview-rail" /><div><span /><span /><span /></div><b style={{ transform: `scale(${0.78 + (scale - 80) / 300})` }}>Aa</b></div>
      <label className="scale-slider-label" htmlFor="ui-scale"><span>Smaller</span><span>Larger</span></label>
      <input id="ui-scale" className="scale-slider" type="range" min="80" max="140" step="5" value={scale} aria-describedby="ui-scale-help" onChange={(event) => onChange(Number(event.target.value))} />
      <div className="scale-presets" role="group" aria-label="Interface scale presets">{SCALE_PRESETS.map((value) => <button type="button" key={value} className={scale === value ? "selected" : ""} aria-pressed={scale === value} onClick={() => onChange(value)}>{value}%</button>)}</div>
      <div className="appearance-footnote"><div><span>Tip</span><p>Start with 110% or 125% on high-resolution displays. You can use the arrow keys while the slider is focused for 5% adjustments.</p></div><button type="button" disabled={scale === 100} onClick={() => onChange(100)}>Reset to 100%</button></div>
    </section>
  </>;
}

function AgentRequired() {
    return <div className="settings-card settings-agent-required"><span>⌁</span><h3>Select an Agent first</h3><p>MCP servers, Skills and Plugins are isolated per Agent. Choose one from the project sidebar, then return here.</p></div>;
}

function EmptyCapability({ icon, title, body }: { icon: string; title: string; body: string }) {
  return <div className="settings-empty"><span>{icon}</span><div><b>{title}</b><p>{body}</p></div></div>;
}
