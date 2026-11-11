/**
 * ProxySupervisor — spawns and supervises the mitmdump child process
 * (services/proxy/flow_sink.py addon loaded, ADR-002).
 *
 * Readiness is signalled externally: the orchestrator routes the addon_ready
 * event (via IngestServer) to markReady().
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROXY_DEFAULTS } from "@kanna/shared";

export interface ProxySupervisorOptions {
  /** Path to the mitmdump executable (see resolveMitmdumpPath). */
  mitmdumpPath: string;
  /** Path to flow_sink.py. */
  addonPath: string;
  listenHost?: string;
  listenPort?: number;
  /** ws:// URL of the Node ingest server. */
  ingestUrl: string;
  /** Comma-separated host[:port] allowlist spec (see flow_sink.py parse_scope). */
  scopeSpec: string;
  maxBodyBytes?: number;
  interceptEnabled?: boolean;
  onLog?(line: string): void;
  onExit?(code: number | null): void;
}

export function resolveMitmdumpPath(repoRoot: string): string {
  const isWindows = process.platform === "win32";
  const mitmdump = join(
    repoRoot,
    "services",
    "proxy",
    ".venv",
    isWindows ? "Scripts" : "bin",
    isWindows ? "mitmdump.exe" : "mitmdump",
  );
  return mitmdump;
}

export function resolveAddonPath(): string {
  // packages/traffic/dist/proxy-supervisor.js → repo root is four levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "services", "proxy", "flow_sink.py");
}

export class ProxySupervisor {
  private child: ChildProcess | null = null;
  private readyResolve: (() => void) | null = null;
  private ready = false;
  private exited = false;
  private readonly opts: Required<Pick<ProxySupervisorOptions, "listenHost" | "listenPort">> &
    ProxySupervisorOptions;

  constructor(options: ProxySupervisorOptions) {
    this.opts = {
      listenHost: PROXY_DEFAULTS.listenHost,
      listenPort: PROXY_DEFAULTS.listenPort,
      maxBodyBytes: PROXY_DEFAULTS.maxBodyBytes,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (!existsSync(this.opts.mitmdumpPath)) {
      throw new Error(
        `mitmdump not found at ${this.opts.mitmdumpPath} — run: node scripts/setup-proxy.mjs`,
      );
    }
    if (!existsSync(this.opts.addonPath)) {
      throw new Error(`flow_sink.py not found at ${this.opts.addonPath}`);
    }
    const args = [
      "--listen-host",
      this.opts.listenHost,
      "--listen-port",
      String(this.opts.listenPort),
      "-s",
      this.opts.addonPath,
      "--set",
      `kanna_ingest_url=${this.opts.ingestUrl}`,
      "--set",
      `kanna_scope=${this.opts.scopeSpec}`,
      "--set",
      `kanna_max_body=${this.opts.maxBodyBytes}`,
      "--set",
      `kanna_intercept=${this.opts.interceptEnabled ? "true" : "false"}`,
      "--set",
      "termlog_verbosity=warn",
      "--set",
      "flow_detail=0",
    ];
    this.opts.onLog?.(`spawning: ${this.opts.mitmdumpPath} ${args.join(" ")}`);
    this.child = spawn(this.opts.mitmdumpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) this.opts.onLog?.(`[mitmdump] ${line.trim()}`);
      }
    });
    this.child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) this.opts.onLog?.(`[mitmdump:err] ${line.trim()}`);
      }
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      this.opts.onExit?.(code);
      this.readyResolve?.();
      this.readyResolve = null;
    });
  }

  /** Called by the orchestrator when addon_ready arrives via the ingest server. */
  markReady(): void {
    this.ready = true;
    this.readyResolve?.();
    this.readyResolve = null;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Resolves on addon_ready (or rejects after timeout). */
  async waitForReady(timeoutMs = 20_000): Promise<void> {
    if (this.ready) return;
    if (this.exited) throw new Error("mitmdump exited before becoming ready");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolve = null;
        reject(new Error(`proxy addon not ready within ${timeoutMs}ms`));
      }, timeoutMs);
      this.readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    const child = this.child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000);
    await exited;
    clearTimeout(timeout);
    this.child = null;
  }

  get exitedBeforeReady(): boolean {
    return this.exited;
  }
}
