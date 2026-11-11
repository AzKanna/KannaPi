import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BenchAgentPort } from "@kanna/agent";
import {
  type AttackGraph,
  type BenchChallenge,
  type BenchLog,
  type BenchRun,
  type BenchRunOptions,
  type BenchSession,
  type BenchSessionMessage,
  type BenchSessionSummary,
  type BenchSettings,
  type BenchSubmitResult,
  type BenchTaskResult,
  newId,
  type Project,
} from "@kanna/shared";
import { BenchClient, type BenchClientPort, BenchError, benchBaseUrl, benchCode, benchString, benchToken, BENCH_SDK_VERSION } from "./bench-client.js";
import { writePrivateJsonFile } from "./private-json-file.js";

interface StoredBenchAuth { baseUrl: string; token: string }
export interface BenchSolveRequest {
  runId: string;
  sessionId: string;
  agentId: string;
  challenge: BenchChallenge;
  addresses: string[];
  allowHints: boolean;
  maxRounds: number;
  minutesPerChallenge: number;
  signal: AbortSignal;
  tools: BenchAgentPort;
  log(entry: Omit<BenchLog, "at" | "challengeCode">): void;
  message(entry: Omit<BenchSessionMessage, "id" | "at">): void;
  graph(value: AttackGraph): void;
}
export type BenchSolver = (request: BenchSolveRequest) => Promise<{ complete: boolean; summary?: string }>;

const MAX_LOGS = 800;
const MAX_TEXT = 4_000;
const MAX_SESSION_MESSAGES = 300;

export class BenchWorkspaceService {
  private auth: StoredBenchAuth = { baseUrl: "", token: "" };
  private runs: BenchRun[] = [];
  private sessions: BenchSession[] = [];
  private active?: {
    run: BenchRun;
    controller: AbortController;
    promise: Promise<void>;
    current?: { code: string; controller: AbortController };
  };
  private saveQueue = Promise.resolve();
  private sessionSaveQueue = Promise.resolve();
  private sessionSaveTimer?: NodeJS.Timeout;
  private readonly sessionsPath: string;

  constructor(
    private readonly authPath: string,
    private readonly runsPath: string,
    private readonly solve: BenchSolver,
    private readonly clientFactory: (baseUrl: string, token: string) => BenchClientPort = (baseUrl, token) =>
      new BenchClient(baseUrl, token),
    sessionsPath = join(dirname(runsPath), "bench-sessions.json"),
  ) { this.sessionsPath = sessionsPath; }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.authPath, "utf8")) as Partial<StoredBenchAuth>;
      this.auth = {
        baseUrl: typeof value.baseUrl === "string" ? benchBaseUrl(value.baseUrl) : "",
        token: typeof value.token === "string" ? benchToken(value.token) : "",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const value = JSON.parse(await readFile(this.runsPath, "utf8")) as unknown;
      if (Array.isArray(value)) {
        this.runs = value
          .filter((run): run is BenchRun => Boolean(run && typeof run === "object" && typeof (run as BenchRun).id === "string"))
          .slice(0, 50)
          .map((run) =>
            run.status === "running" || run.status === "stopping"
              ? { ...run, status: "interrupted", finishedAt: Date.now(), error: "Application closed before Bench run finished",
                  tasks: run.tasks.map((item) => ["queued", "starting", "solving"].includes(item.status)
                    ? { ...item, status: "stopped" as const } : item) }
              : run,
          );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const value = JSON.parse(await readFile(this.sessionsPath, "utf8")) as unknown;
      if (Array.isArray(value)) {
        this.sessions = value.filter((item): item is BenchSession =>
          Boolean(item && typeof item === "object" && typeof (item as BenchSession).id === "string" &&
            Array.isArray((item as BenchSession).messages)));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const run of this.runs) {
      for (const item of run.tasks) {
        if (item.sessionDeleted) continue;
        if (!item.sessionId) item.sessionId = newId("bss");
        const existing = this.sessions.find((session) => session.id === item.sessionId);
        if (existing) {
          existing.status = item.status;
          if (existing.graph && (existing.graph.status === "running" || existing.graph.status === "summarizing")) {
            const status = existing.graph.status === "summarizing" ? "completed" : "stopped";
            existing.graph.status = status;
            existing.graph.nodes = existing.graph.nodes.map((node) =>
              node.status === "running" || node.status === "summarizing" ? { ...node, status } : node);
            existing.graph.completedAt = Date.now();
          }
          continue;
        }
        this.sessions.push({
          id: item.sessionId, projectId: run.projectId, agentId: run.agentId, runId: run.id,
          challengeCode: item.code, status: item.status, createdAt: run.startedAt,
          updatedAt: run.finishedAt ?? run.startedAt,
          messages: run.logs.filter((log) => log.challengeCode === item.code).map((log) => ({
            id: newId("bmsg"), role: log.kind === "assistant" ? "assistant" : "tool",
            text: log.text, at: log.at,
          })),
        });
      }
    }
    await this.saveRuns();
    await this.saveSessions();
  }

  settings(): BenchSettings {
    return { baseUrl: this.auth.baseUrl, tokenConfigured: Boolean(this.auth.token), sdkVersion: BENCH_SDK_VERSION };
  }

  async saveSettings(input: unknown): Promise<BenchSettings> {
    if (this.active) throw new Error("Wait for the active Bench run to finish before changing platform settings");
    const body = record(input);
    const next: StoredBenchAuth = { ...this.auth };
    if ("baseUrl" in body) next.baseUrl = benchBaseUrl(body.baseUrl);
    if (body.clearToken === true) next.token = "";
    else if (typeof body.token === "string" && body.token.trim()) next.token = benchToken(body.token);
    this.auth = next;
    await writePrivateJsonFile(this.authPath, next);
    return this.settings();
  }

  async challenges(): Promise<BenchChallenge[]> {
    const client = this.client();
    await client.checkVpn();
    const challenges = await client.list();
    if (this.updateSessionTitles(challenges)) await this.saveSessions();
    return challenges;
  }

  list(projectId: string): BenchRun[] {
    return this.runs.filter((run) => run.projectId === projectId);
  }

  listSessions(projectId: string): BenchSessionSummary[] {
    return this.sessions.filter((session) => session.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ messages, graph, ...session }) => ({ ...session, messageCount: messages.length, hasGraph: Boolean(graph) }));
  }

  session(projectId: string, sessionId: string): BenchSession {
    const session = this.sessions.find((item) => item.projectId === projectId && item.id === sessionId);
    if (!session) throw new Error("Bench session not found");
    return structuredClone(session);
  }

  async removeSession(projectId: string, sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.projectId === projectId && item.id === sessionId);
    if (!session) throw new Error("Bench session not found");
    if (this.active?.run.id === session.runId) throw new Error("Stop the active Bench run before deleting its Session");
    const run = this.runs.find((item) => item.id === session.runId);
    if (run) {
      const task = run.tasks.find((item) => item.sessionId === sessionId);
      if (task) task.sessionDeleted = true;
      run.logs = run.logs.filter((log) => log.challengeCode !== session.challengeCode);
      await this.saveRuns();
    }
    this.sessions = this.sessions.filter((item) => item.id !== sessionId);
    await this.saveSessions();
  }

  async removeRun(projectId: string, runId: string): Promise<void> {
    const run = this.runs.find((item) => item.projectId === projectId && item.id === runId);
    if (!run) throw new Error("Bench run not found");
    if (this.active?.run.id === runId || run.status === "running" || run.status === "stopping")
      throw new Error("Stop the active Bench run before deleting it");
    if (run.cleanupCode) throw new Error(`Clean up the ${run.cleanupCode} container before deleting this Bench run`);

    // A run owns its challenge workspaces and sandbox snapshots. Never derive a
    // recursive-delete target from an unchecked persisted or URL-provided ID.
    const dataDir = dirname(this.runsPath);
    const workspacesRoot = join(dataDir, "bench-workspaces");
    const sandboxesRoot = join(dataDir, "sandboxes");
    const runWorkspace = childDirectory(workspacesRoot, run.id, "Bench run ID");
    const sessionIds = new Set([
      ...run.tasks.map((item) => item.sessionId).filter((id): id is string => Boolean(id)),
      ...this.sessions.filter((item) => item.projectId === projectId && item.runId === runId).map((item) => item.id),
    ]);
    const directories = new Set<string>([runWorkspace]);
    for (const id of sessionIds) directories.add(childDirectory(sandboxesRoot, id, "Bench session ID"));

    // Earlier builds used a random sandbox ID. Their snapshot marker still
    // records the source challenge workspace, so include only exact descendants
    // of this run instead of clearing the shared sandboxes directory.
    if (await directoryExistsWithoutLink(sandboxesRoot)) {
      for (const entry of await readdir(sandboxesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || sessionIds.has(entry.name) || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
        const directory = childDirectory(sandboxesRoot, entry.name, "Sandbox ID");
        if (!(await directoryExistsWithoutLink(directory))) continue;
        const marker = join(directory, "snapshot.json");
        const metadata = await lstat(marker).catch(missingFile);
        if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
        let source: unknown;
        try { source = (JSON.parse(await readFile(marker, "utf8")) as { source?: unknown }).source; }
        catch { continue; }
        if (typeof source === "string" && isAbsolute(source) && isDescendant(runWorkspace, source))
          directories.add(directory);
      }
    }

    // Verify every target before removing any directory. If filesystem cleanup
    // fails, leave the Run and Session records intact so the user can retry.
    await directoryExistsWithoutLink(workspacesRoot);
    for (const directory of directories) await directoryExistsWithoutLink(directory);
    for (const directory of directories) await rm(directory, { recursive: true, force: true });

    const previousRuns = this.runs;
    const previousSessions = this.sessions;
    this.runs = this.runs.filter((item) => !(item.projectId === projectId && item.id === runId));
    this.sessions = this.sessions.filter((item) => !(item.projectId === projectId && item.runId === runId));
    try {
      await this.saveRuns();
      await this.saveSessions();
    } catch (error) {
      this.runs = previousRuns;
      this.sessions = previousSessions;
      await Promise.allSettled([this.saveRuns(), this.saveSessions()]);
      throw error;
    }
  }

  assertAgentIdle(agentId: string): void {
    if (this.active?.run.agentId === agentId) throw new Error("Stop the active Bench run before deleting this Agent");
  }

  assertProjectIdle(projectId: string): void {
    if (this.active?.run.projectId === projectId) throw new Error("Stop the active Bench run before deleting this Project");
  }

  async removeAgent(agentId: string): Promise<void> {
    this.assertAgentIdle(agentId);
    this.runs = this.runs.filter((run) => run.agentId !== agentId);
    this.sessions = this.sessions.filter((session) => session.agentId !== agentId);
    await this.saveRuns();
    await this.saveSessions();
  }

  async removeProject(projectId: string): Promise<void> {
    this.assertProjectIdle(projectId);
    this.runs = this.runs.filter((run) => run.projectId !== projectId);
    this.sessions = this.sessions.filter((session) => session.projectId !== projectId);
    await this.saveRuns();
    await this.saveSessions();
  }

  async start(project: Project, input: unknown): Promise<BenchRun> {
    if (this.active) throw new Error("A Bench run is already active");
    const body = record(input);
    const options = parseOptions(body);
    if (options.authorized !== true) throw new Error("Confirm that this platform task and targets are authorized");
    if (options.allowSandboxNetwork !== true) throw new Error("Allow sandbox networking for this Bench run");
    const run: BenchRun = {
      id: newId("run"),
      projectId: project.id,
      agentId: options.agentId,
      model: "",
      baseUrl: this.auth.baseUrl,
      status: "running",
      startedAt: Date.now(),
      options,
      tasks: options.challengeCodes.map((code) => task(code)),
      logs: [],
    };
    this.sessions.unshift(...run.tasks.map((item) => ({
      id: item.sessionId!, projectId: project.id, agentId: options.agentId, runId: run.id,
      challengeCode: item.code, status: item.status, createdAt: run.startedAt,
      updatedAt: run.startedAt, messages: [],
    })));
    const client = this.client();
    const controller = new AbortController();
    this.runs.unshift(run);
    this.runs = this.runs.slice(0, 50);
    await this.saveRuns();
    await this.saveSessions();
    const promise = this.execute(run, client, controller.signal)
      .catch((error) => {
        if (run.status === "running" || run.status === "stopping") {
          run.status = controller.signal.aborted ? "stopped" : "failed";
          run.error = safeError(error);
        }
        for (const item of run.tasks) {
          if (!["queued", "starting", "solving"].includes(item.status)) continue;
          item.status = controller.signal.aborted ? "stopped" : "failed";
          item.error ??= run.error;
          this.syncSession(item);
        }
        this.log(run, "error", run.error ?? "Bench run failed");
      })
      .finally(async () => {
        if (this.active?.run.id === run.id) this.active = undefined;
        if (!run.finishedAt) run.finishedAt = Date.now();
        await this.saveRuns();
        if (this.sessionSaveTimer) clearTimeout(this.sessionSaveTimer);
        this.sessionSaveTimer = undefined;
        await this.saveSessions();
      });
    this.active = { run, controller, promise };
    void promise.catch(() => undefined);
    return run;
  }

  async enqueue(runId: string, projectId: string, input: unknown): Promise<BenchRun> {
    const active = this.active;
    if (!active || active.run.id !== runId || active.run.projectId !== projectId || active.run.status !== "running") {
      throw new Error("This Bench run is no longer accepting queued challenges");
    }
    const body = record(input);
    if (body.authorized !== true || body.allowSandboxNetwork !== true) {
      throw new Error("Confirm authorization and sandbox network access for the queued challenges");
    }
    const codes = Array.isArray(body.challengeCodes) ? body.challengeCodes.map(benchCode).slice(0, 20) : [];
    if (!codes.length) throw new Error("Select at least one challenge to queue");
    if (new Set(codes).size !== codes.length || codes.some((code) => active.run.tasks.some((item) => item.code === code))) {
      throw new Error("A selected challenge is already in this Bench run");
    }
    const queued = codes.map(task);
    active.run.tasks.push(...queued);
    this.sessions.unshift(...queued.map((item) => ({
      id: item.sessionId!, projectId, agentId: active.run.agentId, runId,
      challengeCode: item.code, status: item.status, createdAt: Date.now(),
      updatedAt: Date.now(), messages: [],
    })));
    this.log(active.run, "status", `Queued ${codes.length} challenge(s): ${codes.join(", ")}`);
    await this.saveRuns();
    await this.saveSessions();
    return active.run;
  }

  async stopCurrent(runId: string, projectId: string): Promise<BenchRun> {
    const active = this.active;
    if (!active || active.run.id !== runId || active.run.projectId !== projectId || !active.current) {
      throw new Error("No active Bench challenge to stop");
    }
    this.log(active.run, "status", `Stop requested for ${active.current.code}; queued challenges will continue`, active.current.code);
    active.current.controller.abort();
    await this.saveRuns();
    return active.run;
  }

  async stop(runId: string, projectId: string): Promise<BenchRun> {
    const active = this.active;
    if (!active || active.run.id !== runId || active.run.projectId !== projectId) throw new Error("Active Bench run not found");
    active.run.status = "stopping";
    this.log(active.run, "status", "Stop requested; closing the current challenge after cancellation");
    active.controller.abort();
    await this.saveRuns();
    await active.promise.catch(() => undefined);
    return active.run;
  }

  async cleanup(runId: string, projectId: string, authorized: boolean): Promise<BenchRun> {
    if (authorized !== true) throw new Error("Confirm cleanup for the recorded active Bench container");
    const run = this.runs.find((item) => item.id === runId && item.projectId === projectId);
    if (!run) throw new Error("Bench run not found");
    if (this.active?.run.id === runId || run.status === "running" || run.status === "stopping")
      throw new Error("Stop the active Bench run before cleaning up its container");
    if (!run.cleanupCode) throw new Error("This Bench run has no pending cleanup challenge");
    const client = this.client();
    await client.checkVpn();
    const code = run.cleanupCode;
    const closed = await client.close(code);
    const item = run.tasks.find((candidate) => candidate.code === code);
    if (item) item.closed = closed;
    run.cleanupCode = undefined;
    this.log(run, "status", `Cleanup completed for ${code}`);
    await this.saveRuns();
    return run;
  }

  async close(): Promise<void> {
    if (this.active) {
      this.active.controller.abort();
      await this.active.promise.catch(() => undefined);
    }
    await this.saveRuns();
    if (this.sessionSaveTimer) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = undefined;
    await this.saveSessions();
  }

  private client(): BenchClientPort {
    if (!this.auth.baseUrl || !this.auth.token) throw new Error("Configure Benchmark Base URL and Token first");
    return this.clientFactory(this.auth.baseUrl, this.auth.token);
  }

  private async execute(run: BenchRun, client: BenchClientPort, signal: AbortSignal): Promise<void> {
    this.log(run, "status", "Checking VPN and loading challenge list");
    await client.checkVpn(signal);
    const discovered = await client.list(signal);
    this.updateSessionTitles(discovered);
    const challenges = new Map(discovered.map((item) => [item.unique_code, item]));
    for (const code of run.options.challengeCodes) {
      const challenge = challenges.get(code);
      if (!challenge) throw new Error(`Challenge not found in current task: ${code}`);
    }
    for (let index = 0; index < run.tasks.length; index += 1) {
      const item = run.tasks[index]!;
      if (signal.aborted) { item.status = "stopped"; this.syncSession(item); continue; }
      let challenge = challenges.get(item.code);
      if (!challenge) {
        const latest = await client.list(signal);
        this.updateSessionTitles(latest);
        for (const discovered of latest) challenges.set(discovered.unique_code, discovered);
        challenge = challenges.get(item.code);
      }
      if (!challenge) {
        item.status = "failed";
        item.error = `Challenge not found in current task: ${item.code}`;
        this.log(run, "error", item.error, item.code);
        this.syncSession(item);
        continue;
      }
      if (challenge.is_completed) {
        item.status = "skipped"; item.correctFlags = challenge.correct_flag_count; item.totalFlags = challenge.flag_count;
        this.log(run, "status", `${item.code} already completed`, item.code);
        this.syncSession(item);
        continue;
      }
      if (challenge.container_status !== "stopped") {
        item.status = "skipped"; item.error = "Challenge already has an active container; not closing user-managed containers";
        this.log(run, "error", `${item.code} already has an active container; skipped`, item.code);
        this.syncSession(item);
        continue;
      }
      const controller = new AbortController();
      if (this.active?.run.id === run.id) this.active.current = { code: item.code, controller };
      try {
        await this.solveOne(run, item, challenge, client, AbortSignal.any([signal, controller.signal]));
      } finally {
        if (this.active?.run.id === run.id) this.active.current = undefined;
      }
    }
    if (run.status === "running" || run.status === "stopping") run.status = signal.aborted ? "stopped" : "completed";
  }

  private async solveOne(run: BenchRun, item: BenchTaskResult, challenge: BenchChallenge, client: BenchClientPort, signal: AbortSignal): Promise<void> {
    item.status = "starting";
    this.syncSession(item);
    this.log(run, "status", `Starting ${item.code}`, item.code);
    await this.saveRuns();
    let started = false;
    try {
      run.cleanupCode = item.code;
      await this.saveRuns();
      const start = await client.start(item.code, signal);
      started = true;
      if (!start.container_addr.length) throw new Error("Bench container started but returned no address");
      item.addresses = start.container_addr;
      item.status = "solving";
      this.syncSession(item);
      this.log(run, "status", `Container ready: ${start.container_addr.join(", ")}`, item.code);
      const tools = this.toolsFor(run, item, client, signal);
      const solved = await this.solve({
        runId: run.id,
        sessionId: item.sessionId!,
        agentId: run.agentId,
        challenge,
        addresses: start.container_addr,
        allowHints: run.options.allowHints,
        maxRounds: run.options.maxRounds,
        minutesPerChallenge: run.options.minutesPerChallenge,
        signal,
        tools,
        log: (entry) => this.log(run, entry.kind, entry.text, item.code),
        message: (entry) => this.recordMessage(item.sessionId!, entry),
        graph: (value) => this.recordGraph(item.sessionId!, value),
      });
      if (item.correctFlags >= item.totalFlags && item.totalFlags > 0) item.status = "solved";
      else item.status = signal.aborted ? "stopped" : solved.complete ? "solved" : "incomplete";
      if (solved.summary) this.log(run, "assistant", solved.summary, item.code);
      this.syncSession(item);
    } catch (error) {
      item.status = signal.aborted ? "stopped" : "failed";
      item.error = safeError(error);
      this.log(run, "error", item.error, item.code);
      this.syncSession(item);
      if (!started && error instanceof BenchError && ["invalid_state", "resource_unavailable", "challenge_not_found"].includes(error.code)) return;
    } finally {
      if (run.cleanupCode === item.code) {
        try {
          item.closed = await client.close(item.code);
          this.log(run, "status", `Closed ${item.code}`, item.code);
          run.cleanupCode = undefined;
        } catch (error) {
          item.error = item.error ? `${item.error}; cleanup failed` : safeError(error);
          this.log(run, "error", `Cleanup failed for ${item.code}: ${safeError(error)}`, item.code);
          if (!signal.aborted) run.status = "failed";
        }
      }
      await this.saveRuns();
      this.syncSession(item);
    }
  }

  private toolsFor(run: BenchRun, item: BenchTaskResult, client: BenchClientPort, runSignal: AbortSignal): BenchAgentPort {
    let hintUsed = false;
    return {
      submitFlag: async (flag, signal) => {
        if (item.attempts >= run.options.maxSubmissions) throw new Error("Bench submission limit reached for this challenge");
        item.attempts += 1;
        const combined = signal ? AbortSignal.any([runSignal, signal]) : runSignal;
        try {
          const result = await client.submit(item.code, flag, combined);
          this.applySubmission(item, result);
          this.log(run, "submission", `Submission ${result.correct ? "correct" : "incorrect"}; progress ${result.correct_flag_count}/${result.total_flag_count}`, item.code);
          await this.saveRuns();
          return result;
        } catch (error) {
          if (error instanceof BenchError && error.code === "duplicate") {
            this.log(run, "submission", "Duplicate correct flag was ignored by the platform", item.code);
            return { duplicate: true };
          }
          throw error;
        }
      },
      getHint: run.options.allowHints
        ? async (signal) => {
            if (hintUsed) throw new Error("Bench hint already requested for this challenge");
            hintUsed = true;
            item.hintUsed = true;
            await this.saveRuns();
            return client.hint(item.code, signal ? AbortSignal.any([runSignal, signal]) : runSignal);
          }
        : undefined,
      isComplete: () => item.correctFlags >= item.totalFlags && item.totalFlags > 0,
    };
  }

  private applySubmission(item: BenchTaskResult, result: BenchSubmitResult): void {
    item.correctFlags = result.correct_flag_count;
    item.totalFlags = result.total_flag_count;
    item.awarded += result.correct ? result.awarded : 0;
    if (result.correct_flag_count >= result.total_flag_count && result.total_flag_count > 0) item.status = "solved";
  }

  private log(run: BenchRun, kind: BenchLog["kind"], text: string, challengeCode?: string): void {
    const entry: BenchLog = { at: Date.now(), kind, text: redact(text).slice(0, MAX_TEXT), challengeCode };
    run.logs.push(entry);
    if (run.logs.length > MAX_LOGS) {
      run.logs.splice(0, run.logs.length - MAX_LOGS);
      run.logsTruncated = true;
    }
  }

  private saveRuns(): Promise<void> {
    const snapshot = structuredClone(this.runs);
    this.saveQueue = this.saveQueue.catch(() => undefined).then(() => writePrivateJsonFile(this.runsPath, snapshot));
    return this.saveQueue;
  }

  private updateSessionTitles(challenges: BenchChallenge[]): boolean {
    const titles = new Map(challenges.map((challenge) => [challenge.unique_code, challengeTitle(challenge)]));
    let changed = false;
    for (const session of this.sessions) {
      const run = this.runs.find((candidate) => candidate.id === session.runId);
      if (run?.baseUrl !== this.auth.baseUrl) continue;
      const title = titles.get(session.challengeCode);
      if (!title || session.title === title) continue;
      session.title = title;
      session.updatedAt = Date.now();
      changed = true;
    }
    if (changed) this.scheduleSessionSave();
    return changed;
  }

  private syncSession(item: BenchTaskResult): void {
    const session = this.sessions.find((value) => value.id === item.sessionId);
    if (!session) return;
    session.status = item.status;
    session.updatedAt = Date.now();
    this.scheduleSessionSave();
  }

  private recordMessage(sessionId: string, entry: Omit<BenchSessionMessage, "id" | "at">): void {
    const session = this.sessions.find((value) => value.id === sessionId);
    if (!session) return;
    const text = redact(entry.text).slice(0, 8_000);
    const existing = entry.role === "tool" && entry.toolCallId && entry.phase !== "running"
      ? session.messages.find((message) => message.toolCallId === entry.toolCallId && message.phase === "running")
      : undefined;
    if (existing) {
      existing.text = `${existing.text}\n\nResult:\n${text}`.slice(0, 8_000);
      existing.phase = entry.phase;
    } else {
      session.messages.push({ ...entry, text, id: newId("bmsg"), at: Date.now() });
    }
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      session.messages.splice(0, session.messages.length - MAX_SESSION_MESSAGES);
      session.messagesTruncated = true;
    }
    session.updatedAt = Date.now();
    this.scheduleSessionSave();
  }

  private recordGraph(sessionId: string, graph: AttackGraph): void {
    const session = this.sessions.find((value) => value.id === sessionId);
    if (!session) return;
    session.graph = structuredClone(graph);
    session.updatedAt = Date.now();
    this.scheduleSessionSave();
  }

  private scheduleSessionSave(): void {
    if (this.sessionSaveTimer) return;
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = undefined;
      void this.saveSessions();
    }, 250);
  }

  private saveSessions(): Promise<void> {
    const snapshot = structuredClone(this.sessions);
    this.sessionSaveQueue = this.sessionSaveQueue.catch(() => undefined)
      .then(() => writePrivateJsonFile(this.sessionsPath, snapshot));
    return this.sessionSaveQueue;
  }
}

function childDirectory(root: string, name: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid ${label}`);
  const target = resolve(root, name);
  if (dirname(target) !== resolve(root)) throw new Error(`Invalid ${label}`);
  return target;
}

function isDescendant(parent: string, child: string): boolean {
  const path = relative(parent, resolve(child));
  return Boolean(path) && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function missingFile(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT") return undefined;
  throw error;
}

async function directoryExistsWithoutLink(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(missingFile);
  if (!metadata) return false;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Refusing to delete linked or non-directory Bench storage: ${path}`);
  return true;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
  return value as Record<string, unknown>;
}

function parseOptions(value: Record<string, unknown>): BenchRunOptions {
  const codes = Array.isArray(value.challengeCodes) ? value.challengeCodes.map(benchCode).slice(0, 20) : [];
  if (!codes.length) throw new Error("Select at least one Bench challenge");
  if (new Set(codes).size !== codes.length) throw new Error("Bench challenge list contains duplicates");
  const minutesPerChallenge = numberIn(value.minutesPerChallenge, 1, 120, 15);
  return {
    agentId: benchString(value.agentId, 200, "Agent ID").trim(),
    challengeCodes: codes,
    authorized: value.authorized === true,
    allowSandboxNetwork: value.allowSandboxNetwork === true,
    allowHints: value.allowHints === true,
    minutesPerChallenge,
    maxRounds: numberIn(value.maxRounds, 1, 10, 3),
    maxSubmissions: numberIn(value.maxSubmissions, 1, 100, 30),
  };
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Number must be between ${min} and ${max}`);
  return number;
}

function task(code: string): BenchTaskResult {
  return { code, sessionId: newId("bss"), status: "queued", addresses: [], correctFlags: 0, totalFlags: 0, awarded: 0, attempts: 0, hintUsed: false };
}

function challengeTitle(challenge: BenchChallenge): string | undefined {
  const firstLine = challenge.description?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine?.replace(/^#{1,6}\s*/, "").slice(0, 120) || undefined;
}

function redact(value: string): string {
  return value.replace(/(BENCHMARK_TOKEN|api[_-]?key|token)\s*[:=]\s*[\w.-]+/gi, "$1=[redacted]");
}

function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
