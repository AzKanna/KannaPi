import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Project, SshAuthType, SshCommandResult, SshHost } from "@kanna/shared";
import "./ssh-workspace.css";

interface Props {
  project?: Project;
  onError(message: string): void;
}

interface ConnectSecrets {
  password?: string;
  passphrase?: string;
  trustFingerprint?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

export function SshWorkspace({ project, onError }: Props) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [history, setHistory] = useState<SshCommandResult[]>([]);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState<SshHost>();
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");
  const selected = useMemo(
    () => hosts.find((host) => host.id === selectedId),
    [hosts, selectedId],
  );

  async function refreshHosts(projectId = project?.id) {
    if (!projectId) return;
    const values = await api<SshHost[]>(`/api/projects/${projectId}/ssh-hosts`);
    setHosts(values);
    setSelectedId((current) =>
      values.some((host) => host.id === current) ? current : values[0]?.id,
    );
  }

  async function refreshHistory(hostId = selectedId) {
    if (!hostId) {
      setHistory([]);
      return;
    }
    setHistory(await api<SshCommandResult[]>(`/api/ssh-hosts/${hostId}/history?limit=80`));
  }

  useEffect(() => {
    setHosts([]);
    setSelectedId(undefined);
    setHistory([]);
    if (project) void refreshHosts(project.id).catch((reason) => onError(String(reason)));
  }, [project?.id]);

  useEffect(() => {
    void refreshHistory(selectedId).catch((reason) => onError(String(reason)));
    if (!selectedId) return;
    const timer = window.setInterval(() => {
      void Promise.all([refreshHosts(), refreshHistory()]).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  async function connect(host: SshHost, secrets: ConnectSecrets) {
    setBusy(true);
    try {
      await api<SshHost>(`/api/ssh-hosts/${host.id}/connect`, {
        method: "POST",
        body: JSON.stringify(secrets),
      });
      setConnecting(undefined);
      await refreshHosts();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const fingerprint = message.match(/Host key confirmation required: (SHA256:[A-Za-z0-9+/]+)/)?.[1];
      if (
        fingerprint &&
        window.confirm(
          `First connection to ${host.username}@${host.host}:${host.port}.\n\nHost key fingerprint:\n${fingerprint}\n\nTrust this host key and connect?`,
        )
      ) {
        await api<SshHost>(`/api/ssh-hosts/${host.id}/connect`, {
          method: "POST",
          body: JSON.stringify({ ...secrets, trustFingerprint: fingerprint }),
        });
        setConnecting(undefined);
        await refreshHosts();
      } else if (!fingerprint) {
        onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(host: SshHost) {
    setBusy(true);
    try {
      await api<SshHost>(`/api/ssh-hosts/${host.id}/disconnect`, { method: "POST" });
      await refreshHosts();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove(host: SshHost) {
    if (!window.confirm(`Remove SSH host “${host.name}” and its command history?`)) return;
    setBusy(true);
    try {
      await api(`/api/ssh-hosts/${host.id}`, { method: "DELETE" });
      await refreshHosts();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function execute(event: FormEvent) {
    event.preventDefault();
    if (!selected || !command.trim()) return;
    const value = command.trim();
    setBusy(true);
    try {
      const result = await api<SshCommandResult>(`/api/ssh-hosts/${selected.id}/exec`, {
        method: "POST",
        body: JSON.stringify({ command: value, timeoutSeconds: 30 }),
      });
      setCommand("");
      setHistory((current) => [result, ...current.filter((item) => item.id !== result.id)]);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      await refreshHosts().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (!project)
    return (
      <section className="ssh-workspace">
        <div className="ssh-empty"><h2>Choose a project</h2><p>SSH hosts are isolated by project.</p></div>
      </section>
    );

  return (
    <section className="ssh-workspace">
      <header className="ssh-toolbar">
        <div>
          <b>Remote hosts</b>
          <small>Credentials stay in memory for the active connection</small>
        </div>
        <button onClick={() => setCreating(true)}>＋ Add host</button>
      </header>
      <div className="ssh-layout">
        <aside className="ssh-hosts">
          {hosts.map((host) => (
            <button
              key={host.id}
              className={host.id === selectedId ? "selected" : ""}
              onClick={() => setSelectedId(host.id)}
            >
              <span className={`ssh-status ${host.status}`} />
              <div><b>{host.name}</b><small>{host.username}@{host.host}:{host.port}</small></div>
              <i>{host.status}</i>
            </button>
          ))}
          {!hosts.length && <div className="ssh-hosts-empty"><b>No SSH hosts</b><p>Add a host to open a controlled remote shell.</p></div>}
        </aside>
        <div className="ssh-terminal">
          {!selected ? (
            <div className="ssh-empty"><div>›_</div><h2>Remote command workspace</h2><p>Select or add an SSH host. Full-profile Agents can use hosts that you explicitly connect here.</p></div>
          ) : (
            <>
              <header className="ssh-terminal-head">
                <div>
                  <span className={`ssh-status ${selected.status}`} />
                  <div><b>{selected.name}</b><small>{selected.username}@{selected.host}:{selected.port} · {selected.authType}</small></div>
                </div>
                <div>
                  {selected.status === "connected" ? (
                    <button disabled={busy} onClick={() => void disconnect(selected)}>Disconnect</button>
                  ) : (
                    <button className="primary" disabled={busy || selected.status === "connecting"} onClick={() => setConnecting(selected)}>{selected.status === "connecting" ? "Connecting…" : "Connect"}</button>
                  )}
                  <button className="danger" disabled={busy} onClick={() => void remove(selected)}>Remove</button>
                </div>
              </header>
              {selected.hostFingerprint && <div className="ssh-fingerprint"><span>Verified host key</span><code>{selected.hostFingerprint}</code></div>}
              {selected.lastError && <div className="ssh-error">{selected.lastError}</div>}
              <div className="ssh-history" aria-live="polite">
                {history.map((result) => <CommandResult key={result.id} result={result} />)}
                {!history.length && <div className="ssh-history-empty">No commands have run on this host.</div>}
              </div>
              <form className="ssh-command" onSubmit={(event) => void execute(event)}>
                <span>$</span>
                <input
                  aria-label="Remote command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder={selected.status === "connected" ? "Enter a non-interactive command" : "Connect before running commands"}
                  disabled={selected.status !== "connected" || busy}
                  autoComplete="off"
                />
                <button disabled={selected.status !== "connected" || busy || !command.trim()}>{busy ? "Running…" : "Run"}</button>
              </form>
            </>
          )}
        </div>
      </div>
      {creating && <CreateHostDialog project={project} onClose={() => setCreating(false)} onCreated={(host) => { setCreating(false); setHosts((current) => [host, ...current]); setSelectedId(host.id); }} onError={onError} />}
      {connecting && <ConnectDialog host={connecting} busy={busy} onClose={() => !busy && setConnecting(undefined)} onConnect={(secrets) => connect(connecting, secrets)} />}
    </section>
  );
}

function CommandResult({ result }: { result: SshCommandResult }) {
  const success = !result.timedOut && result.exitCode === 0;
  return <article className={`ssh-result ${success ? "success" : "failed"}`}>
    <header><code>$ {result.command}</code><span>{result.actor} · {result.timedOut ? "timeout" : result.exitCode == null ? result.signal ?? "closed" : `exit ${result.exitCode}`}</span></header>
    {result.stdout && <pre>{result.stdout}</pre>}
    {result.stderr && <pre className="stderr">{result.stderr}</pre>}
    <footer>{new Date(result.startedAt).toLocaleString()} · {Math.max(result.endedAt - result.startedAt, 0)} ms</footer>
  </article>;
}

function CreateHostDialog({ project, onClose, onCreated, onError }: { project: Project; onClose(): void; onCreated(host: SshHost): void; onError(message: string): void }) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<SshAuthType>("password");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      onCreated(await api<SshHost>(`/api/projects/${project.id}/ssh-hosts`, {
        method: "POST",
        body: JSON.stringify({ name, host, port: Number(port), username, authType, privateKeyPath: authType === "private-key" ? privateKeyPath : undefined }),
      }));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }
  return <div className="modal-backdrop"><div className="dialog"><header><h2>Add SSH host</h2><button aria-label="Close" onClick={onClose}>×</button></header><form onSubmit={(event) => void submit(event)}>
    <div className="field-grid"><label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Production VM" /></label><label>Host<input required value={host} onChange={(event) => setHost(event.target.value)} placeholder="10.0.0.20" /></label></div>
    <div className="field-grid"><label>Port<input required type="number" min="1" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label><label>Username<input required value={username} onChange={(event) => setUsername(event.target.value)} placeholder="ubuntu" /></label></div>
    <label>Authentication<select value={authType} onChange={(event) => setAuthType(event.target.value as SshAuthType)}><option value="password">Password</option><option value="private-key">Private key</option></select></label>
    {authType === "private-key" && <label>Private key path<input required value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} placeholder="C:\path\to\id_ed25519" /></label>}
    <p className="field-help">Passwords and passphrases are requested when connecting and are never saved. The key path is saved; the key file stays on this machine.</p>
    <button className="primary" disabled={saving}>{saving ? "Adding…" : "Add host"}</button>
  </form></div></div>;
}

function ConnectDialog({ host, busy, onClose, onConnect }: { host: SshHost; busy: boolean; onClose(): void; onConnect(secrets: ConnectSecrets): Promise<void> }) {
  const [secret, setSecret] = useState("");
  return <div className="modal-backdrop"><div className="dialog"><header><h2>Connect to {host.name}</h2><button aria-label="Close" disabled={busy} onClick={onClose}>×</button></header><form onSubmit={(event) => { event.preventDefault(); void onConnect(host.authType === "password" ? { password: secret } : { passphrase: secret || undefined }); }}>
    <p className="ssh-connect-target">{host.username}@{host.host}:{host.port}</p>
    <label>{host.authType === "password" ? "Password" : "Private key passphrase (optional)"}<input autoFocus type="password" required={host.authType === "password"} autoComplete="current-password" value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
    <p className="field-help">The secret is held only for this live connection. On first use, verify the server fingerprint before trusting it.</p>
    <button className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
  </form></div></div>;
}
