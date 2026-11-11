import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Project } from "@kanna/shared";
import { newId } from "@kanna/shared";
import { writePrivateJsonFile } from "./private-json-file.js";

export type NucleiSeverity = "info" | "low" | "medium" | "high" | "critical";
export type NucleiRunStatus = "running" | "completed" | "failed" | "stopped";

export interface NucleiFinding {
  id: string;
  templateId: string;
  name: string;
  severity: NucleiSeverity;
  matchedAt: string;
  type: string;
  description?: string;
  reference?: string;
}

export interface NucleiRun {
  id: string;
  projectId: string;
  target: string;
  severity: NucleiSeverity[];
  rateLimit: number;
  status: NucleiRunStatus;
  startedAt: number;
  finishedAt?: number;
  findings: NucleiFinding[];
  error?: string;
  truncated?: boolean;
}

const SEVERITIES = new Set<NucleiSeverity>(["info", "low", "medium", "high", "critical"]);
const MAX_FINDINGS = 300;
const MAX_STDERR = 4_000;
const MAX_LINE = 128_000;
const SCAN_TIMEOUT_MS = 30 * 60_000;

export function validateNucleiTarget(value: string): string {
  if (
    value.length > 2_048 ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Target URL is invalid");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter one HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("Enter one HTTP or HTTPS URL without credentials, query or fragment");
  return url.href;
}

export function parseNucleiFinding(line: string): NucleiFinding | undefined {
  if (line.length > MAX_LINE) return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const info = record.info && typeof record.info === "object" ? (record.info as Record<string, unknown>) : {};
  const severity = String(info.severity ?? "info").toLowerCase() as NucleiSeverity;
  const templateId = String(record["template-id"] ?? "").slice(0, 200);
  if (!SEVERITIES.has(severity) || !templateId) return undefined;
  const references = info.reference;
  const reference = Array.isArray(references)
    ? String(references[0] ?? "")
    : typeof references === "string"
      ? references
      : "";
  return {
    id: newId("fnd"),
    templateId,
    name: String(info.name ?? templateId).slice(0, 300),
    severity,
    matchedAt: String(record["matched-at"] ?? record.host ?? "").slice(0, 2_048),
    type: String(record.type ?? "http").slice(0, 40),
    description: typeof info.description === "string" ? info.description.slice(0, 2_000) : undefined,
    reference: /^https?:\/\//i.test(reference) ? reference.slice(0, 2_048) : undefined,
  };
}

export function nucleiArgs(target: string, severities: NucleiSeverity[], rateLimit: number): string[] {
  return [
    "-u",
    target,
    "-pt",
    "http",
    "-s",
    severities.join(","),
    "-rl",
    String(rateLimit),
    "-c",
    "5",
    "-timeout",
    "5",
    "-retries",
    "0",
    "-dr",
    "-j",
    "-silent",
    "-or",
    "-ot",
    "-duc",
    "-no-stdin",
  ];
}

function scannerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/(?:API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete environment[key];
  }
  return environment;
}

export class NucleiWorkspaceService {
  private runs: NucleiRun[] = [];
  private active?: { run: NucleiRun; process: ChildProcess; timeout: NodeJS.Timeout; closed: Promise<void> };
  private saveQueue = Promise.resolve();

  constructor(
    private readonly storePath: string,
    private readonly command = "nuclei",
    private readonly preArgs: string[] = [],
  ) {}

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.storePath, "utf8")) as unknown;
      if (Array.isArray(value))
        this.runs = value
          .filter((run): run is NucleiRun =>
            Boolean(
              run &&
                typeof run === "object" &&
                typeof run.id === "string" &&
                typeof run.projectId === "string",
            ),
          )
          .slice(0, 100)
          .map((run) =>
            run.status === "running"
              ? {
                  ...run,
                  status: "stopped",
                  finishedAt: Date.now(),
                  error: "Application closed before scan finished",
                }
              : run,
          );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(projectId: string): NucleiRun[] {
    return this.runs.filter((run) => run.projectId === projectId);
  }

  async availability(): Promise<{ available: boolean; version?: string; error?: string }> {
    return await new Promise((resolve) => {
      const child = spawn(this.command, [...this.preArgs, "-version"], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => child.kill(), 5_000);
      child.stdout.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(0, 300);
      });
      child.stderr.on("data", (data: Buffer) => {
        output = (output + data.toString()).slice(0, 300);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ available: false, error: "Nuclei was not found on PATH" });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(
          code === 0
            ? { available: true, version: output.trim() }
            : { available: false, error: output.trim() || "Nuclei failed to start" },
        );
      });
    });
  }

  async start(
    project: Project,
    input: { target: string; severity: NucleiSeverity[]; rateLimit: number; authorized: boolean },
  ): Promise<NucleiRun> {
    if (input.authorized !== true) throw new Error("Confirm that you are authorized to scan this target");
    if (this.active) throw new Error("A Nuclei scan is already running");
    const target = validateNucleiTarget(input.target);
    const severity = input.severity;
    if (!Array.isArray(severity) || severity.length === 0 || severity.some((value) => !SEVERITIES.has(value)))
      throw new Error("Select valid severities");
    if (!Number.isInteger(input.rateLimit) || input.rateLimit < 1 || input.rateLimit > 20)
      throw new Error("Rate limit must be between 1 and 20 requests per second");
    const status = await this.availability();
    if (!status.available) throw new Error(status.error ?? "Nuclei is not installed");
    const run: NucleiRun = {
      id: newId("run"),
      projectId: project.id,
      target,
      severity,
      rateLimit: input.rateLimit,
      status: "running",
      startedAt: Date.now(),
      findings: [],
    };
    const child = spawn(this.command, [...this.preArgs, ...nucleiArgs(target, severity, input.rateLimit)], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: scannerEnvironment(),
    });
    const timeout = setTimeout(() => {
      run.error = "Scan exceeded the 30-minute limit";
      child.kill();
    }, SCAN_TIMEOUT_MS);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    this.active = { run, process: child, timeout, closed };
    this.runs.unshift(run);
    this.runs = this.runs.slice(0, 100);
    let pending = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      pending += data.toString("utf8");
      if (pending.length > MAX_LINE * 2) {
        pending = "";
        run.truncated = true;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const finding = parseNucleiFinding(line);
        if (!finding) continue;
        if (run.findings.length < MAX_FINDINGS) run.findings.push(finding);
        else run.truncated = true;
      }
      void this.save().catch((error: NodeJS.ErrnoException) =>
        console.warn("Nuclei state save failed:", error.code),
      );
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString("utf8")).slice(-MAX_STDERR);
    });
    child.once("error", (error) => {
      run.error = error.message;
    });
    child.once("close", (code) => {
      const tail = parseNucleiFinding(pending);
      if (tail && run.findings.length < MAX_FINDINGS) run.findings.push(tail);
      clearTimeout(timeout);
      if (this.active?.run.id === run.id) this.active = undefined;
      if (run.status === "running") run.status = code === 0 && !run.error ? "completed" : "failed";
      if (run.status === "failed" && !run.error)
        run.error = stderr.trim().slice(-1_000) || `Nuclei exited with code ${code}`;
      run.finishedAt = Date.now();
      void this.save().catch((error: NodeJS.ErrnoException) =>
        console.warn("Nuclei state save failed:", error.code),
      );
    });
    try {
      await this.save();
    } catch (error) {
      child.kill();
      await this.waitForExit(closed);
      throw error;
    }
    return run;
  }

  async stop(runId: string, projectId: string): Promise<NucleiRun> {
    const active = this.active;
    if (!active || active.run.id !== runId || active.run.projectId !== projectId)
      throw new Error("Running scan not found");
    active.run.status = "stopped";
    active.run.finishedAt = Date.now();
    active.process.kill();
    await this.waitForExit(active.closed);
    await this.save();
    return active.run;
  }

  async close(): Promise<void> {
    if (this.active) {
      const active = this.active;
      active.run.status = "stopped";
      active.run.finishedAt = Date.now();
      active.process.kill();
      clearTimeout(active.timeout);
      await this.waitForExit(active.closed);
    }
    await this.save();
  }

  private async waitForExit(closed: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Nuclei is still closing; retry after the process exits")),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.runs);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => writePrivateJsonFile(this.storePath, snapshot));
    return this.saveQueue;
  }
}
