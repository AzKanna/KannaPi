import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BenchChallenge } from "@kanna/shared";
import { afterEach, expect, test } from "vitest";
import type { BenchClientPort } from "./bench-client.js";
import { BenchWorkspaceService } from "./bench-workspace.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "kanna-bench-"));
  folders.push(directory);
  return { auth: join(directory, "auth.json"), runs: join(directory, "runs.json") };
}

const project = { id: "prj_test", name: "Test", workspacePath: process.cwd(), createdAt: 1, updatedAt: 1 };
const challenge: BenchChallenge = {
  unique_code: "web_001",
  description: "Find the flag on the authorized lab target.",
  difficulty: "easy",
  level: 1,
  total_score: 10,
  flag_count: 1,
  correct_flag_count: 0,
  is_completed: false,
  container_status: "stopped",
  container_addr: [],
};

class FakeBenchClient implements BenchClientPort {
  starts = 0;
  submissions = 0;
  closes = 0;
  async checkVpn() { return { ok: true }; }
  async list() { return [challenge]; }
  async start() { this.starts += 1; return { unique_code: challenge.unique_code, container_addr: ["10.0.0.8:8080"] }; }
  async submit() {
    this.submissions += 1;
    return { correct: true, awarded: 10, cumulative_score: 10, correct_flag_count: 1, total_flag_count: 1, matched_flag_index: 0 };
  }
  async hint() { return "try /flag"; }
  async close() { this.closes += 1; return true; }
}

test("runs a selected Bench challenge through the solver and always closes it", async () => {
  const paths = await files();
  const client = new FakeBenchClient();
  const service = new BenchWorkspaceService(
    paths.auth,
    paths.runs,
    async (request) => {
      expect(request.addresses).toEqual(["10.0.0.8:8080"]);
      request.message({ role: "user", text: "Solve web_001" });
      request.message({ role: "tool", toolName: "powershell", toolCallId: "call_1", phase: "running", text: "curl target" });
      request.message({ role: "tool", toolName: "powershell", toolCallId: "call_1", phase: "completed", text: "FLAG{ok}" });
      request.message({ role: "assistant", text: "Found a flag in the response." });
      request.graph({ agentId: request.agentId, sessionId: request.sessionId, runId: request.runId,
        status: "completed", startedAt: 1, completedAt: 2,
        nodes: [{ id: "node_1", kind: "objective", title: "Find flag", status: "completed", timestamp: 1 }], edges: [] });
      await request.tools.submitFlag("FLAG{ok}");
      return { complete: Boolean(request.tools.isComplete?.()), summary: "solved" };
    },
    () => client,
  );
  await service.load();
  await service.saveSettings({ baseUrl: "https://bench.example.test", token: "token-test" });
  const run = await service.start(project, {
    agentId: "agent_test",
    challengeCodes: ["web_001"],
    authorized: true,
    allowSandboxNetwork: true,
    minutesPerChallenge: 1,
    maxRounds: 1,
    maxSubmissions: 3,
  });
  await waitFor(() => service.list(project.id)[0]?.status === "completed");
  expect(service.list(project.id)[0]).toMatchObject({
    id: run.id,
    status: "completed",
    tasks: [{ status: "solved", correctFlags: 1, closed: true }],
  });
  expect(client).toMatchObject({ starts: 1, submissions: 1, closes: 1 });
  const session = service.listSessions(project.id)[0];
  expect(session).toMatchObject({ challengeCode: "web_001", title: "Find the flag on the authorized lab target.", status: "solved", messageCount: 3, hasGraph: true });
  expect(service.session(project.id, session!.id).messages[1]).toMatchObject({ toolName: "powershell", phase: "completed", text: "curl target\n\nResult:\nFLAG{ok}" });
  await service.close();
  const reopened = new BenchWorkspaceService(paths.auth, paths.runs, async () => ({ complete: false }), () => new FakeBenchClient());
  await reopened.load();
  expect(reopened.session(project.id, session!.id).graph?.nodes[0]?.title).toBe("Find flag");
  await reopened.removeSession(project.id, session!.id);
  expect(reopened.listSessions(project.id)).toEqual([]);
  expect(() => reopened.session(project.id, session!.id)).toThrow("Bench session not found");
  const afterDeletion = new BenchWorkspaceService(paths.auth, paths.runs, async () => ({ complete: false }), () => new FakeBenchClient());
  await afterDeletion.load();
  expect(afterDeletion.listSessions(project.id)).toEqual([]);
  expect(afterDeletion.list(project.id)[0]?.tasks[0]?.sessionDeleted).toBe(true);
  expect(afterDeletion.list(project.id)[0]?.logs.some((log) => log.challengeCode === challenge.unique_code)).toBe(false);
  await afterDeletion.removeAgent("agent_test");
  expect(afterDeletion.list(project.id)).toEqual([]);
  expect(JSON.stringify(JSON.parse(await readFile(paths.runs, "utf8")))).not.toContain("token-test");
});

test("persists settings without exposing the token in public settings", async () => {
  const paths = await files();
  const service = new BenchWorkspaceService(paths.auth, paths.runs, async () => ({ complete: false }), () => new FakeBenchClient());
  await service.load();
  const settings = await service.saveSettings({ baseUrl: "https://bench.example.test/", token: "token-test" });
  expect(settings).toEqual({ baseUrl: "https://bench.example.test", tokenConfigured: true, sdkVersion: "tsec-benchmark 0.1.2 protocol" });
  expect(JSON.stringify(settings)).not.toContain("token-test");
  expect(JSON.parse(await readFile(paths.auth, "utf8")).token).toBe("token-test");
});

test("deleting one finished run removes its Sessions and local workspaces without touching another run", async () => {
  const paths = await files();
  const service = new BenchWorkspaceService(paths.auth, paths.runs, async (request) => {
    request.message({ role: "assistant", text: "Challenge finished" });
    return { complete: true };
  }, () => new FakeBenchClient());
  await service.load();
  await service.saveSettings({ baseUrl: "https://bench.example.test", token: "token-test" });
  const input = { agentId: "agent_test", challengeCodes: ["web_001"], authorized: true,
    allowSandboxNetwork: true, minutesPerChallenge: 1, maxRounds: 1, maxSubmissions: 3 };
  const first = await service.start(project, input);
  await waitFor(() => Boolean(first.finishedAt));
  const second = await service.start(project, input);
  await waitFor(() => Boolean(second.finishedAt));

  const dataDir = dirname(paths.runs);
  const firstWorkspace = join(dataDir, "bench-workspaces", first.id);
  const secondWorkspace = join(dataDir, "bench-workspaces", second.id);
  const firstSandbox = join(dataDir, "sandboxes", first.tasks[0]!.sessionId!);
  const legacySandbox = join(dataDir, "sandboxes", "run_legacy_snapshot");
  const secondSandbox = join(dataDir, "sandboxes", second.tasks[0]!.sessionId!);
  for (const directory of [firstWorkspace, secondWorkspace, firstSandbox, legacySandbox, secondSandbox])
    await mkdir(directory, { recursive: true });
  await writeFile(join(firstWorkspace, "script.txt"), "first run");
  await writeFile(join(secondWorkspace, "script.txt"), "second run");
  await writeFile(join(firstSandbox, "snapshot.json"), JSON.stringify({ source: join(firstWorkspace, "web_001") }));
  await writeFile(join(legacySandbox, "snapshot.json"), JSON.stringify({ source: join(firstWorkspace, "web_001") }));
  await writeFile(join(secondSandbox, "snapshot.json"), JSON.stringify({ source: join(secondWorkspace, "web_001") }));

  await expect(service.removeRun("prj_other", first.id)).rejects.toThrow("Bench run not found");
  await service.removeRun(project.id, first.id);
  expect(service.list(project.id).map((run) => run.id)).toEqual([second.id]);
  expect(service.listSessions(project.id).map((session) => session.runId)).toEqual([second.id]);
  for (const directory of [firstWorkspace, firstSandbox, legacySandbox])
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  for (const directory of [secondWorkspace, secondSandbox])
    expect((await stat(directory)).isDirectory()).toBe(true);
  expect((JSON.parse(await readFile(paths.runs, "utf8")) as Array<{ id: string }>).map((run) => run.id)).toEqual([second.id]);
  expect((JSON.parse(await readFile(join(dataDir, "bench-sessions.json"), "utf8")) as Array<{ runId: string }>).map((session) => session.runId)).toEqual([second.id]);
  await service.close();
});

test("cannot delete a running Bench run or a run awaiting container cleanup", async () => {
  const paths = await files();
  const service = new BenchWorkspaceService(paths.auth, paths.runs, async (request) => {
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { complete: false };
  }, () => new FakeBenchClient());
  await service.load();
  await service.saveSettings({ baseUrl: "https://bench.example.test", token: "token-test" });
  const run = await service.start(project, { agentId: "agent_test", challengeCodes: ["web_001"], authorized: true,
    allowSandboxNetwork: true, minutesPerChallenge: 1, maxRounds: 1, maxSubmissions: 3 });
  await expect(service.removeRun(project.id, run.id)).rejects.toThrow("Stop the active Bench run");
  await waitFor(() => run.cleanupCode === "web_001");
  await expect(service.cleanup(run.id, project.id, true)).rejects.toThrow("Stop the active Bench run");
  await service.stop(run.id, project.id);
  run.cleanupCode = "web_001";
  await expect(service.removeRun(project.id, run.id)).rejects.toThrow("Clean up the web_001 container");
  run.cleanupCode = undefined;
  await service.removeRun(project.id, run.id);
  expect(service.list(project.id)).toEqual([]);
  await service.close();
});

test("queues a newly discovered challenge and stops only the current challenge", async () => {
  const paths = await files();
  const nextChallenge: BenchChallenge = { ...challenge, unique_code: "web_002" };
  const client = new FakeBenchClient();
  const available = [challenge];
  client.list = async () => available;
  const service = new BenchWorkspaceService(paths.auth, paths.runs, async (request) => {
    if (request.challenge.unique_code === "web_001") {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { complete: false };
    }
    request.message({ role: "assistant", text: "Second challenge completed" });
    return { complete: true };
  }, () => client);
  await service.load();
  await service.saveSettings({ baseUrl: "https://bench.example.test", token: "token-test" });
  const run = await service.start(project, {
    agentId: "agent_test", challengeCodes: ["web_001"], authorized: true,
    allowSandboxNetwork: true, minutesPerChallenge: 1, maxRounds: 1, maxSubmissions: 3,
  });
  await waitFor(() => run.tasks[0]?.status === "solving");
  available.push(nextChallenge);
  await expect(service.enqueue(run.id, project.id, { challengeCodes: ["web_002"] })).rejects.toThrow("Confirm authorization");
  await service.enqueue(run.id, project.id, {
    challengeCodes: ["web_002"], authorized: true, allowSandboxNetwork: true,
  });
  expect(run.tasks.map((item) => item.status)).toEqual(["solving", "queued"]);
  expect(service.listSessions(project.id).map((item) => item.challengeCode)).toContain("web_002");
  await service.stopCurrent(run.id, project.id);
  await waitFor(() => service.list(project.id)[0]?.status === "completed");
  expect(run.tasks.map((item) => item.status)).toEqual(["stopped", "solved"]);
  expect(client.closes).toBe(2);
  await service.close();
  const reopened = new BenchWorkspaceService(paths.auth, paths.runs, async () => ({ complete: false }), () => new FakeBenchClient());
  await reopened.load();
  expect(reopened.list(project.id)[0]?.tasks.map((item) => item.code)).toEqual(["web_001", "web_002"]);
});

test("stopping a whole run also stops its queued challenges", async () => {
  const paths = await files();
  const client = new FakeBenchClient();
  client.list = async () => [challenge, { ...challenge, unique_code: "web_002" }];
  const service = new BenchWorkspaceService(paths.auth, paths.runs, async (request) => {
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { complete: false };
  }, () => client);
  await service.load();
  await service.saveSettings({ baseUrl: "https://bench.example.test", token: "token-test" });
  const run = await service.start(project, {
    agentId: "agent_test", challengeCodes: ["web_001", "web_002"], authorized: true,
    allowSandboxNetwork: true, minutesPerChallenge: 1, maxRounds: 1, maxSubmissions: 3,
  });
  await waitFor(() => run.tasks[0]?.status === "solving");
  await service.stop(run.id, project.id);
  expect(run.status).toBe("stopped");
  expect(run.tasks.map((item) => item.status)).toEqual(["stopped", "stopped"]);
  expect(client.starts).toBe(1);
});

async function waitFor(condition: () => boolean | undefined) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 2000) throw new Error("Timed out waiting for Bench run");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
