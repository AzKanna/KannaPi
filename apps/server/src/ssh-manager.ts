import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SshCommandHistoryRepo, SshHostsRepo, StoredSshHost } from "@kanna/database";
import { newId, type SshCommandResult, type SshHost } from "@kanna/shared";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

interface ConnectionState {
  client?: Client;
  status: SshHost["status"];
  lastError?: string;
}

export interface SshConnectSecrets {
  password?: string;
  passphrase?: string;
  trustFingerprint?: string;
}

export class SshConnectionManager {
  private readonly connections = new Map<string, ConnectionState>();

  constructor(
    private readonly hosts: SshHostsRepo,
    private readonly history: SshCommandHistoryRepo,
    private readonly emitHost: (host: SshHost) => void,
    private readonly emitCommand: (projectId: string, result: SshCommandResult) => void,
  ) {}

  list(projectId: string): SshHost[] {
    return this.hosts.list(projectId).map((host) => this.publicHost(host));
  }

  get(id: string): SshHost | undefined {
    const host = this.hosts.get(id);
    return host ? this.publicHost(host) : undefined;
  }

  async connect(id: string, secrets: SshConnectSecrets): Promise<SshHost> {
    const host = this.requireHost(id);
    const existing = this.connections.get(id);
    if (existing?.status === "connected") return this.publicHost(host);
    existing?.client?.destroy();
    this.setState(host, { status: "connecting" });

    let presentedFingerprint: string | undefined;
    let privateKey: Buffer | undefined;
    if (host.authType === "password" && !secrets.password)
      throw this.fail(host, "Password is required for this connection");
    if (host.authType === "private-key") {
      if (!host.privateKeyPath) throw this.fail(host, "Private key path is required");
      try {
        privateKey = await readFile(host.privateKeyPath);
      } catch (error) {
        throw this.fail(
          host,
          `Could not read private key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const client = new Client();
    const expectedFingerprint = host.hostFingerprint ?? secrets.trustFingerprint;
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      password: host.authType === "password" ? secrets.password : undefined,
      privateKey,
      passphrase: secrets.passphrase || undefined,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => {
        presentedFingerprint = fingerprint(key);
        return presentedFingerprint === expectedFingerprint;
      },
    };

    return new Promise<SshHost>((resolve, reject) => {
      let ready = false;
      const rejectConnection = (error: Error) => {
        if (ready) return;
        const message =
          host.hostFingerprint && presentedFingerprint && host.hostFingerprint !== presentedFingerprint
            ? `Host key mismatch. Expected ${host.hostFingerprint}, received ${presentedFingerprint}`
            : !host.hostFingerprint &&
                presentedFingerprint &&
                secrets.trustFingerprint !== presentedFingerprint
              ? `Host key confirmation required: ${presentedFingerprint}`
              : error.message;
        this.setState(host, { status: "error", lastError: message });
        client.destroy();
        reject(new Error(message));
      };
      client.once("error", rejectConnection);
      client.once("ready", () => {
        ready = true;
        client.removeListener("error", rejectConnection);
        let persisted = host;
        if (!host.hostFingerprint && presentedFingerprint) {
          persisted = { ...host, hostFingerprint: presentedFingerprint, updatedAt: Date.now() };
          this.hosts.save(persisted);
        }
        this.connections.set(id, { client, status: "connected" });
        client.on("error", (error) =>
          this.setState(persisted, { status: "error", lastError: error.message }),
        );
        client.once("close", () => {
          if (this.connections.get(id)?.client === client)
            this.setState(persisted, { status: "disconnected" });
        });
        const value = this.publicHost(persisted);
        this.emitHost(value);
        resolve(value);
      });
      client.connect(config);
    });
  }

  disconnect(id: string): SshHost {
    const host = this.requireHost(id);
    this.connections.get(id)?.client?.end();
    this.setState(host, { status: "disconnected" });
    return this.publicHost(host);
  }

  delete(id: string): boolean {
    this.connections.get(id)?.client?.destroy();
    this.connections.delete(id);
    return this.hosts.delete(id);
  }

  historyFor(id: string, limit = 50): SshCommandResult[] {
    this.requireHost(id);
    return this.history.list(id, limit);
  }

  async execute(
    id: string,
    command: string,
    options: { actor: SshCommandResult["actor"]; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SshCommandResult> {
    const host = this.requireHost(id);
    const state = this.connections.get(id);
    if (state?.status !== "connected" || !state.client)
      throw new Error(`SSH host is not connected: ${host.name}`);
    const normalized = command.trim();
    if (!normalized) throw new Error("SSH command is required");
    if (normalized.length > 4_000) throw new Error("SSH command exceeds 4000 characters");
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), 120_000);
    const startedAt = Date.now();

    return new Promise<SshCommandResult>((resolve, reject) => {
      state.client?.exec(normalized, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        this.collectCommand(
          host,
          stream,
          normalized,
          options.actor,
          startedAt,
          timeoutMs,
          options.signal,
        ).then(resolve, reject);
      });
    });
  }

  async close(): Promise<void> {
    for (const state of this.connections.values()) state.client?.end();
    this.connections.clear();
  }

  private collectCommand(
    host: StoredSshHost,
    stream: ClientChannel,
    command: string,
    actor: SshCommandResult["actor"],
    startedAt: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SshCommandResult> {
    return new Promise((resolve) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let exitCode: number | undefined;
      let exitSignal: string | undefined;
      let timedOut = false;
      let settled = false;
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const remaining = MAX_OUTPUT_BYTES - stdout.length - stderr.length;
        return remaining <= 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const result: SshCommandResult = {
          id: newId("sshcmd"),
          hostId: host.id,
          actor,
          command,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          exitCode,
          signal: exitSignal,
          timedOut,
          startedAt,
          endedAt: Date.now(),
        };
        this.history.save(result);
        this.emitCommand(host.projectId, result);
        resolve(result);
      };
      const abort = () => {
        exitSignal = "ABORT";
        try {
          stream.signal("KILL");
          stream.close();
        } catch {
          finish();
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        exitSignal = "TIMEOUT";
        try {
          stream.signal("KILL");
          stream.close();
        } catch {
          finish();
        }
      }, timeoutMs);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      stream.on("data", (chunk: Buffer) => {
        stdout = append(stdout, Buffer.from(chunk));
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, Buffer.from(chunk));
      });
      stream.on("exit", (code: number | null, remoteSignal?: string) => {
        exitCode = code ?? undefined;
        if (remoteSignal) exitSignal = remoteSignal;
      });
      stream.once("close", finish);
      stream.once("error", finish);
    });
  }

  private requireHost(id: string): StoredSshHost {
    const host = this.hosts.get(id);
    if (!host) throw new Error("SSH host not found");
    return host;
  }

  private publicHost(host: StoredSshHost): SshHost {
    const state = this.connections.get(host.id);
    return {
      ...host,
      status: state?.status ?? "disconnected",
      lastError: state?.lastError,
    };
  }

  private setState(host: StoredSshHost, state: ConnectionState): Error {
    this.connections.set(host.id, state);
    this.emitHost(this.publicHost(host));
    return new Error(state.lastError ?? "SSH connection failed");
  }

  private fail(host: StoredSshHost, message: string): Error {
    return this.setState(host, { status: "error", lastError: message });
  }
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}
