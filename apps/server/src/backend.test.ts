import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionsRepo, BodyStore, FindingsRepo, FlowsRepo, openDatabase, SessionsRepo } from "@kanna/database";
import { defaultLocalScope, newId } from "@kanna/shared";
import { IngestServer } from "@kanna/traffic";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { RestApi, startPlatform, UiEventBus } from "./main.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function fakeChatModel() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const requestBody = Buffer.concat(chunks).toString("utf8");
      requests.push(requestBody);
      const content = requestBody.includes("semantic execution graph")
        ? JSON.stringify({
            nodes: [
              {
                key: "objective",
                kind: "objective",
                title: "Understand the request",
                detail: "Review the user objective.",
              },
              {
                key: "analysis",
                kind: "analysis",
                title: "Assess available context",
                detail: "Use the observable conversation context.",
              },
              {
                key: "outcome",
                kind: "outcome",
                title: "Return the result",
                detail: "Platform response was produced.",
              },
            ],
            edges: [
              { source: "objective", target: "analysis", label: "frames" },
              { source: "analysis", target: "outcome", label: "produces" },
            ],
          })
        : "Platform response";
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finishReason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-platform", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      send({ content });
      send({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake model failed to bind");
  return { server, port: address.port, requests };
}

async function fakeToolFirstModel() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      const hasToolResult = (JSON.parse(body) as { messages: Array<{ role: string }> }).messages.some(
        (message) => message.role === "tool",
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finishReason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-tool-first", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      if (body.includes("semantic execution graph")) {
        send({ content: '{"nodes":[],"edges":[]}' });
        send({}, "stop");
        response.end("data: [DONE]\n\n");
      } else if (hasToolResult) {
        setTimeout(() => {
          send({ content: "I read the workspace note." });
          send({}, "stop");
          response.end("data: [DONE]\n\n");
        }, 700);
      } else {
        send({ tool_calls: [{ index: 0, id: "call_read_note", type: "function", function: { name: "read", arguments: '{"path":"notes.txt"}' } }] });
        send({}, "tool_calls");
        response.end("data: [DONE]\n\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake tool-first model failed to bind");
  return { server, port: address.port, requests };
}

describe("server backend", () => {
  test("deletes a Bench run through the API together with its Session and local files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-bench-delete-api-"));
    dirs.push(dir);
    const dataDir = join(dir, "data");
    const first = await startPlatform({ repoRoot: dir, dataDir, port: 0 });
    let projectId: string;
    try {
      const response = await fetch(`http://127.0.0.1:${first.port}/api/projects`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Bench cleanup", workspacePath: dir }),
      });
      expect(response.status).toBe(201);
      projectId = (await response.json() as { id: string }).id;
    } finally { await first.close(); }

    const runId = newId("run");
    const sessionId = newId("bss");
    await writeFile(join(dataDir, "bench-runs.json"), JSON.stringify([{
      id: runId, projectId, agentId: "agent_test", model: "", baseUrl: "", status: "completed",
      startedAt: 1, finishedAt: 2, options: { challengeCodes: ["web_001"] },
      tasks: [{ code: "web_001", sessionId, status: "solved" }], logs: [],
    }]));
    await writeFile(join(dataDir, "bench-sessions.json"), JSON.stringify([{
      id: sessionId, projectId, agentId: "agent_test", runId, challengeCode: "web_001",
      status: "solved", createdAt: 1, updatedAt: 2, messages: [],
    }]));
    const workspace = join(dataDir, "bench-workspaces", runId);
    const sandbox = join(dataDir, "sandboxes", sessionId);
    await mkdir(workspace, { recursive: true });
    await mkdir(sandbox, { recursive: true });
    await writeFile(join(workspace, "note.txt"), "run-only file");
    await writeFile(join(sandbox, "note.txt"), "sandbox-only file");

    const second = await startPlatform({ repoRoot: dir, dataDir, port: 0 });
    try {
      const base = `http://127.0.0.1:${second.port}`;
      const response = await fetch(`${base}/api/projects/${projectId}/bench/runs/${runId}`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: true });
      expect(await fetch(`${base}/api/projects/${projectId}/bench/runs`).then((result) => result.json())).toEqual([]);
      expect(await fetch(`${base}/api/projects/${projectId}/bench/sessions`).then((result) => result.json())).toEqual([]);
      await expect(stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(sandbox)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await second.close(); }
  });

  test("streams run and tool progress before a tool-first model emits assistant text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-agent-progress-"));
    dirs.push(dir);
    await writeFile(join(dir, "notes.txt"), "This is a test note.");
    const fake = await fakeToolFirstModel();
    const platform = await startPlatform({ repoRoot: dir, dataDir: join(dir, "data"), port: 0 });
    const base = `http://127.0.0.1:${platform.port}`;
    const json = (body: object) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let ws: WebSocket | undefined;
    try {
      expect((await fetch(`${base}/api/model-config`, { method: "POST", ...json({
        providerId: "fake", providerName: "Fake", baseUrl: `http://127.0.0.1:${fake.port}/v1`,
        modelId: "fake-model", modelName: "Fake", apiKey: "secret",
      }) })).status).toBe(200);
      const project = await fetch(`${base}/api/projects`, { method: "POST", ...json({ name: "Progress test", workspacePath: dir }) }).then((response) => response.json()) as { id: string };
      const agent = await fetch(`${base}/api/projects/${project.id}/agents`, { method: "POST", ...json({ name: "Reader", toolProfile: "read-only" }) }).then((response) => response.json()) as { id: string };
      const [session] = await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) => response.json()) as Array<{ id: string }>;
      if (!session) throw new Error("Default Session was not created");
      const events: Array<Record<string, unknown>> = [];
      ws = new WebSocket(`ws://127.0.0.1:${platform.port}/ui`);
      ws.on("message", (data) => {
        const event = JSON.parse(String(data)) as Record<string, unknown>;
        if (event.agentId === agent.id && event.sessionId === session.id) events.push(event);
      });
      await new Promise<void>((resolve, reject) => {
        ws?.once("open", resolve);
        ws?.once("error", reject);
      });
      expect((await fetch(`${base}/api/agents/${agent.id}/sessions/${session.id}/messages`, {
        method: "POST", ...json({ message: "Read notes.txt and explain it" }),
      })).status).toBe(202);
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "agent_tool" && event.phase === "end"); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const runStart = events.findIndex((event) => event.type === "agent_chat_run" && event.status === "running");
      const toolStart = events.findIndex((event) => event.type === "agent_tool" && event.phase === "start");
      const toolEnd = events.findIndex((event) => event.type === "agent_tool" && event.phase === "end");
      expect(runStart).toBeGreaterThanOrEqual(0);
      expect(toolStart).toBeGreaterThan(runStart);
      expect(toolEnd).toBeGreaterThan(toolStart);
      expect(events.slice(0, toolEnd + 1).some((event) => event.type === "agent_delta" ||
        (event.type === "agent_message" && (event.message as { role?: string })?.role === "assistant"))).toBe(false);
      for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === "agent_chat_run" && event.status === "idle"); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events.some((event) => event.type === "agent_delta" && String(event.delta).includes("I read"))).toBe(true);
      expect(events.some((event) => event.type === "agent_chat_run" && event.status === "idle")).toBe(true);
      expect(fake.requests.some((body) => body.includes('"role":"tool"'))).toBe(true);
      expect(fake.requests.some((body) => body.includes("briefly tell the user in your text response"))).toBe(true);
      const history = await fetch(`${base}/api/agents/${agent.id}/sessions/${session.id}/messages`).then((response) => response.json()) as Array<{ role: string; toolName?: string; toolCallId?: string }>;
      expect(history.some((message) => message.role === "tool" && message.toolName === "read" && message.toolCallId === "call_read_note")).toBe(true);
    } finally {
      ws?.close();
      await platform.close();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });
  test("edits and deletes Projects, Agents, and even the last Session without deleting the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-management-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    const otherWorkspace = join(dir, "other-workspace");
    await mkdir(workspace);
    await mkdir(otherWorkspace);
    await writeFile(join(workspace, "keep.txt"), "user-owned");
    const platform = await startPlatform({ repoRoot: dir, dataDir: join(dir, "data"), port: 0 });
    let platformClosed = false;
    const base = `http://127.0.0.1:${platform.port}`;
    const json = (body: object) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      await fetch(`${base}/api/model-config`, { method: "POST", ...json({
        providerId: "fake", providerName: "Fake", baseUrl: "http://127.0.0.1:1/v1",
        modelId: "fake-model", modelName: "Fake", apiKey: "secret",
      }) });
      const project = await fetch(`${base}/api/projects`, { method: "POST", ...json({ name: "Before", workspacePath: workspace }) }).then((response) => response.json()) as { id: string };
      const agent = await fetch(`${base}/api/projects/${project.id}/agents`, { method: "POST", ...json({ name: "Before Agent", toolProfile: "chat" }) }).then((response) => response.json()) as { id: string };
      const [session] = await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) => response.json()) as Array<{ id: string }>;
      if (!session) throw new Error("Default Session was not created");
      const badSession = await fetch(`${base}/api/agents/${agent.id}/sessions/${session.id}`, { method: "PATCH", ...json({ name: "Bad", workspacePath: join(dir, "missing") }) });
      expect(badSession.status).toBe(400);
      const updatedSession = await fetch(`${base}/api/agents/${agent.id}/sessions/${session.id}`, { method: "PATCH", ...json({ name: "Renamed Session", workspacePath: otherWorkspace }) }).then((response) => response.json()) as { name: string; workspacePath: string };
      expect(updatedSession).toMatchObject({ name: "Renamed Session", workspacePath: otherWorkspace });
      const updatedAgent = await fetch(`${base}/api/agents/${agent.id}`, { method: "PATCH", ...json({ name: "Renamed Agent", systemPrompt: "Keep replies concise.", toolProfile: "read-only" }) }).then((response) => response.json()) as { name: string; toolProfile: string };
      expect(updatedAgent).toMatchObject({ name: "Renamed Agent", toolProfile: "read-only" });
      const updatedProject = await fetch(`${base}/api/projects/${project.id}`, { method: "PATCH", ...json({ name: "Renamed Project", description: "Revised", workspacePath: otherWorkspace }) }).then((response) => response.json()) as { name: string; workspacePath: string };
      expect(updatedProject).toMatchObject({ name: "Renamed Project", workspacePath: otherWorkspace });
      expect(platform.runtime.agents.get(agent.id)?.cwd).toBe(otherWorkspace);
      const deletedSession = await fetch(`${base}/api/agents/${agent.id}/sessions/${session.id}`, { method: "DELETE" });
      expect(deletedSession.status).toBe(200);
      expect(await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) => response.json())).toEqual([]);
      await platform.close();
      platformClosed = true;
      const restarted = await startPlatform({ repoRoot: dir, dataDir: join(dir, "data"), port: 0 });
      try {
        const restartedBase = `http://127.0.0.1:${restarted.port}`;
        expect(await fetch(`${restartedBase}/api/agents/${agent.id}/sessions`).then((response) => response.json())).toEqual([]);
        const newSession = await fetch(`${restartedBase}/api/agents/${agent.id}/sessions`, { method: "POST", ...json({ name: "New" }) }).then((response) => response.json()) as { workspacePath: string };
        expect(newSession.workspacePath).toBe(otherWorkspace);
        expect((await fetch(`${restartedBase}/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(200);
        expect(await fetch(`${restartedBase}/api/projects/${project.id}/agents`).then((response) => response.json())).toEqual([]);
        const secondAgent = await fetch(`${restartedBase}/api/projects/${project.id}/agents`, { method: "POST", ...json({ name: "Second" }) }).then((response) => response.json()) as { id: string };
        expect(secondAgent.id).toBeTruthy();
        expect((await fetch(`${restartedBase}/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(200);
        expect(await fetch(`${restartedBase}/api/projects`).then((response) => response.json())).toEqual([]);
        expect((await stat(join(workspace, "keep.txt"))).isFile()).toBe(true);
      } finally { await restarted.close(); }
    } finally {
      if (!platformClosed) await platform.close();
    }
  });
  test("serves persisted actions and broadcasts live events on /ui", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-server-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "kanna.db"));
    const sessions = new SessionsRepo(db);
    const actions = new ActionsRepo(db);
    const flows = new FlowsRepo(db, new BodyStore(db));
    const findings = new FindingsRepo(db);
    sessions.create({
      id: "sess_1",
      startedAt: 1,
      target: "http://localhost:3000",
      scope: defaultLocalScope([3000]),
    });
    actions.save({
      id: "act_1",
      sessionId: "sess_1",
      seq: 1,
      type: "navigate",
      params: {},
      pageId: "pg_1",
      startedAt: 1,
      status: "completed",
      correlatedFlowIds: [],
    });

    const ingest = new IngestServer({ port: 0, onProxyEvent: () => undefined });
    new RestApi(ingest, { sessions, actions, flows, findings });
    const bus = new UiEventBus(ingest);
    await ingest.start();
    try {
      const response = await fetch(`http://127.0.0.1:${ingest.port}/actions?sessionId=sess_1`);
      expect(response.status).toBe(200);
      expect((await response.json()) as unknown[]).toHaveLength(1);

      const message = new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${ingest.port}/ui`);
        ws.on("open", () => bus.broadcast({ type: "run", status: "running", sessionId: "sess_1" }));
        ws.on("message", (data) => {
          resolve(String(data));
          ws.close();
        });
        ws.on("error", reject);
      });
      expect(JSON.parse(await message)).toMatchObject({ type: "run", status: "running" });
    } finally {
      await bus.close();
      await ingest.stop();
      db.close();
    }
  });

  test("upgrades a saved DeepSeek Flash model to controllable thinking on startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-deepseek-upgrade-"));
    dirs.push(dir);
    const dataDir = join(dir, "data");
    await mkdir(dataDir);
    await writeFile(join(dataDir, "models.json"), JSON.stringify({ providers: {
      DeepSeek: {
        name: "DeepSeek-flash",
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        models: [{ id: "deepseek-flash", name: "deepseek-flash", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 }],
      },
    } }));
    await writeFile(join(dataDir, "auth.json"), JSON.stringify({ DeepSeek: { type: "api_key", key: "saved-secret" } }));
    await writeFile(join(dataDir, "active-model.json"), JSON.stringify({ providerId: "DeepSeek", modelId: "deepseek-flash" }));

    const platform = await startPlatform({ repoRoot: dir, dataDir, port: 0 });
    try {
      expect(platform.runtime.getModelConfig()).toMatchObject({
        modelId: "deepseek-flash",
        keyConfigured: true,
        reasoning: true,
        thinkingLevel: "high",
      });
      expect(await platform.runtime.listModels()).toContainEqual(expect.objectContaining({
        modelId: "deepseek-flash",
        thinkingLevels: ["off", "low", "high", "max"],
      }));
    } finally {
      await platform.close();
    }
  });

  test("serves the project, asset and generic Agent workspace API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-platform-"));
    dirs.push(dir);
    const platform = await startPlatform({
      repoRoot: dir,
      dataDir: join(dir, "data"),
      modelsPath: join(dir, "models.json"),
      providerId: "fake",
      modelId: "fake-model",
      apiKey: "fake-key",
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${platform.port}`;
      const configResponse = await fetch(`${base}/api/model-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "fake",
          providerName: "Fake",
          baseUrl: "http://127.0.0.1:9999/v1",
          modelId: "fake-model",
          modelName: "Fake model",
          apiKey: "fake-key",
        }),
      });
      expect(configResponse.status).toBe(200);
      const projectResponse = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "General project", workspacePath: dir }),
      });
      expect(projectResponse.status).toBe(201);
      const project = (await projectResponse.json()) as { id: string };
      const sshHostResponse = await fetch(`${base}/api/projects/${project.id}/ssh-hosts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Lab VM",
          host: "127.0.0.1",
          port: 2222,
          username: "tester",
          authType: "password",
          password: "must-not-be-saved",
        }),
      });
      expect(sshHostResponse.status).toBe(201);
      const sshHost = (await sshHostResponse.json()) as Record<string, unknown>;
      expect(sshHost).toMatchObject({
        projectId: project.id,
        name: "Lab VM",
        status: "disconnected",
      });
      expect(sshHost.password).toBeUndefined();
      const sshHosts = (await fetch(`${base}/api/projects/${project.id}/ssh-hosts`).then((response) =>
        response.json(),
      )) as Array<Record<string, unknown>>;
      expect(sshHosts).toHaveLength(1);
      expect(JSON.stringify(sshHosts)).not.toContain("must-not-be-saved");
      const agentResponse = await fetch(`${base}/api/projects/${project.id}/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "General Agent", toolProfile: "read-only" }),
      });
      expect(agentResponse.status).toBe(201);
      const agent = (await agentResponse.json()) as { id: string };
      const initialSessions = (await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) =>
        response.json(),
      )) as Array<{ id: string; name: string; workspacePath: string }>;
      expect(initialSessions).toHaveLength(1);
      expect(initialSessions[0]?.workspacePath).toBe(dir);
      const alternateWorkspace = join(dir, "alternate-workspace");
      await mkdir(alternateWorkspace);
      const sessionResponse = await fetch(`${base}/api/agents/${agent.id}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Alternate", workspacePath: alternateWorkspace }),
      });
      expect(sessionResponse.status).toBe(201);
      const alternateSession = (await sessionResponse.json()) as { id: string; workspacePath: string };
      expect(alternateSession.workspacePath).toBe(alternateWorkspace);
      expect(await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) => response.json())).toHaveLength(2);
      expect((await fetch(`${base}/api/agents/${agent.id}/sessions/${alternateSession.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) => response.json())).toHaveLength(1);
      const agents = (await fetch(`${base}/api/projects/${project.id}/agents`).then((response) =>
        response.json(),
      )) as unknown[];
      expect(agents).toHaveLength(1);
      const skillDir = join(dir, "skills", "test-helper");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: test-helper\ndescription: Test helper\n---\n\n# Test\n",
      );
      const skillResponse = await fetch(`${base}/api/agents/${agent.id}/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: skillDir }),
      });
      expect(skillResponse.status).toBe(201);
      const capabilities = (await fetch(`${base}/api/agents/${agent.id}/capabilities`).then((response) =>
        response.json(),
      )) as { skills: Array<{ names: string[] }>; mcpServers: unknown[] };
      expect(capabilities.skills[0]?.names).toEqual(["test-helper"]);
      expect(capabilities.mcpServers).toEqual([]);
      const uploaded = await fetch(`${base}/api/agents/${agent.id}/skills/upload`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "SKILL.md", content: "---\nname: uploaded-helper\ndescription: Uploaded helper\n---\n\n# Use\nRead this instruction.\n" }),
      });
      expect(uploaded.status).toBe(201);
      const uploadedSkill = (await uploaded.json()) as { id: string; path: string; names: string[] };
      expect(uploadedSkill.names).toEqual(["uploaded-helper"]);
      expect((await stat(uploadedSkill.path)).isFile()).toBe(true);
      expect((await fetch(`${base}/api/agents/${agent.id}/skills/upload`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "notes.txt", content: "hello" }),
      })).status).toBeGreaterThanOrEqual(400);
      expect((await fetch(`${base}/api/agents/${agent.id}/skills/${uploadedSkill.id}`, { method: "DELETE" })).status).toBe(200);
      await expect(stat(uploadedSkill.path)).rejects.toMatchObject({ code: "ENOENT" });

      const pluginBody = { filename: "sample.ts", content: "export default (pi) => { pi.on('agent_start', () => {}); };" };
      expect((await fetch(`${base}/api/agents/${agent.id}/plugins`, {
        method: "POST", headers: { "content-type": "text/plain" },
        body: JSON.stringify({ ...pluginBody, trusted: true }),
      })).status).toBeGreaterThanOrEqual(400);
      expect((await fetch(`${base}/api/agents/${agent.id}/plugins`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" },
        body: JSON.stringify({ ...pluginBody, trusted: true }),
      })).status).toBeGreaterThanOrEqual(400);
      expect((await fetch(`${base}/api/agents/${agent.id}/plugins`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pluginBody),
      })).status).toBeGreaterThanOrEqual(400);
      const pluginResponse = await fetch(`${base}/api/agents/${agent.id}/plugins`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...pluginBody, trusted: true }),
      });
      expect(pluginResponse.status).toBe(201);
      const plugin = (await pluginResponse.json()) as { id: string; path: string; enabled: boolean };
      expect((await stat(plugin.path)).isFile()).toBe(true);
      expect(((await fetch(`${base}/api/agents/${agent.id}/capabilities`).then((response) => response.json())) as { plugins: unknown[] }).plugins).toHaveLength(1);
      const disabled = await fetch(`${base}/api/agents/${agent.id}/plugins/${plugin.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
      });
      expect((await disabled.json()) as { enabled: boolean }).toMatchObject({ enabled: false });
      expect((await fetch(`${base}/api/agents/${agent.id}/plugins/${plugin.id}`, { method: "DELETE" })).status).toBe(200);
      await expect(stat(plugin.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await platform.close();
    }
  });

  test("runs a generic Agent message through the platform API and exposes the persisted history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-platform-chat-"));
    dirs.push(dir);
    const fake = await fakeChatModel();
    const platform = await startPlatform({ repoRoot: dir, dataDir: join(dir, "data"), port: 0 });
    let platformClosed = false;
    try {
      const base = `http://127.0.0.1:${platform.port}`;
      await fetch(`${base}/api/model-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "fake",
          providerName: "Fake",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          modelId: "fake-model",
          modelName: "Fake",
          apiKey: "secret",
        }),
      });
      const connection = (await fetch(`${base}/api/model-config/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((response) => response.json())) as { ok: boolean; preview: string };
      expect(connection.ok).toBe(true);
      expect(connection.preview).toContain("Platform response");
      const project = (await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Chat", workspacePath: dir }),
      }).then((response) => response.json())) as { id: string };
      const agent = (await fetch(`${base}/api/projects/${project.id}/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "General", toolProfile: "chat" }),
      }).then((response) => response.json())) as { id: string };
      const chatSession = (await fetch(`${base}/api/agents/${agent.id}/sessions`).then((response) =>
        response.json(),
      )) as Array<{ id: string }>;
      expect(chatSession).toHaveLength(1);
      const chatSessionId = chatSession[0]!.id;
      await fetch(`${base}/api/model-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "fake",
          providerName: "Fake",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          modelId: "fake-model-2",
          modelName: "Fake 2",
          supportsImages: true,
          reasoning: true,
          thinkingLevel: "medium",
        }),
      });
      const configuredModels = (await fetch(`${base}/api/models`).then((response) =>
        response.json(),
      )) as Array<{ modelId: string }>;
      expect(configuredModels.map((model) => model.modelId)).toEqual(["fake-model-2", "fake-model"]);
      const switched = (await fetch(`${base}/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "fake", modelId: "fake-model-2" }),
      }).then((response) => response.json())) as { id: string; modelId: string };
      expect(switched.modelId).toBe("fake-model-2");
      const strengthened = (await fetch(`${base}/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thinkingLevel: "high" }),
      }).then((response) => response.json())) as { thinkingLevel: string };
      expect(strengthened.thinkingLevel).toBe("high");
      const persistedAgent = platform.runtime.agents.get(agent.id);
      if (!persistedAgent) throw new Error("Agent was not persisted");
      platform.runtime.agents.save({
        ...persistedAgent,
        providerId: "demo",
        modelId: "demo",
      });
      const upload = await fetch(`${base}/api/agents/${agent.id}/attachments`, {
        method: "POST",
        headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("notes 中文.txt") },
        body: "attachment body",
      });
      expect(upload.status).toBe(201);
      const attachment = (await upload.json()) as { id: string; name: string; size: number };
      expect(attachment).toMatchObject({ name: "notes 中文.txt", size: 15 });
      const downloaded = await fetch(`${base}/api/agents/${agent.id}/attachments/${attachment.id}`);
      expect(downloaded.headers.get("content-type")).toBe("text/plain");
      expect(await downloaded.text()).toBe("attachment body");
      const imageUpload = await fetch(`${base}/api/agents/${agent.id}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png", "x-file-name": "sample.png" },
        body: new Uint8Array([137, 80, 78, 71]),
      });
      expect(imageUpload.status).toBe(201);
      const imageAttachment = (await imageUpload.json()) as { id: string };
      const sent = await fetch(`${base}/api/agents/${agent.id}/sessions/${chatSessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Hello",
          attachmentIds: [attachment.id, imageAttachment.id],
        }),
      });
      expect(sent.status).toBe(202);
      let history: Array<{
        role: string;
        text: string;
        attachments?: Array<{ id: string; name: string }>;
      }> = [];
      for (let attempt = 0; attempt < 50; attempt++) {
        history = (await fetch(`${base}/api/agents/${agent.id}/sessions/${chatSessionId}/messages`).then((response) =>
          response.json(),
        )) as typeof history;
        if (history.some((message) => message.text.includes("Platform response"))) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(history.some((message) => message.role === "user" && message.text === "Hello")).toBe(true);
      expect(history.find((message) => message.role === "user")?.attachments).toEqual([
        expect.objectContaining({ id: attachment.id, name: "notes 中文.txt" }),
        expect.objectContaining({ id: imageAttachment.id, name: "sample.png" }),
      ]);
      expect(fake.requests.some((request) => request.includes("iVBORw=="))).toBe(true);
      expect(
        history.some((message) => message.role === "assistant" && message.text.includes("Platform response")),
      ).toBe(true);
      let graph: { status: string; nodes: Array<{ kind: string; detail?: string }> } = {
        status: "running",
        nodes: [],
      };
      for (let attempt = 0; attempt < 100; attempt++) {
        graph = (await fetch(`${base}/api/agents/${agent.id}/attack-graph`).then((response) =>
          response.json(),
        )) as typeof graph;
        if (graph.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(graph.status).toBe("completed");
      expect(graph.nodes.map((node) => node.kind)).toEqual(["objective", "analysis", "outcome"]);
      expect(graph.nodes.at(-1)?.detail).toContain("Platform response");
      const originalGraph = await fetch(`${base}/api/agents/${agent.id}/sessions/${chatSessionId}/attack-graph`)
        .then((response) => response.json()) as typeof graph;
      expect(originalGraph.nodes.map((node) => node.kind)).toEqual(["objective", "analysis", "outcome"]);
      const isolatedSession = (await fetch(`${base}/api/agents/${agent.id}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Isolated", workspacePath: dir }),
      }).then((response) => response.json())) as { id: string };
      expect(
        await fetch(`${base}/api/agents/${agent.id}/sessions/${isolatedSession.id}/messages`).then(
          (response) => response.json(),
        ),
      ).toEqual([]);
      await fetch(`${base}/api/agents/${agent.id}/sessions/${isolatedSession.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Second conversation" }),
      });
      let isolatedHistory: Array<{ role: string; text: string }> = [];
      for (let attempt = 0; attempt < 50; attempt++) {
        isolatedHistory = (await fetch(
          `${base}/api/agents/${agent.id}/sessions/${isolatedSession.id}/messages`,
        ).then((response) => response.json())) as typeof isolatedHistory;
        if (isolatedHistory.some((message) => message.role === "assistant")) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(isolatedHistory.some((message) => message.text === "Second conversation")).toBe(true);
      const originalHistory = (await fetch(
        `${base}/api/agents/${agent.id}/sessions/${chatSessionId}/messages`,
      ).then((response) => response.json())) as typeof isolatedHistory;
      expect(originalHistory.some((message) => message.text === "Second conversation")).toBe(false);
      expect((await fetch(`${base}/api/agents/${agent.id}/sessions/${chatSessionId}/attack-graph`)
        .then((response) => response.json()) as typeof graph).nodes.at(-1)?.detail).toContain("Platform response");
      expect(platform.runtime.agents.get(agent.id)).toMatchObject({
        providerId: "fake",
        modelId: "fake-model-2",
        thinkingLevel: "high",
      });
      const publicConfig = (await fetch(`${base}/api/model-config`).then((response) =>
        response.json(),
      )) as Record<string, unknown>;
      expect(publicConfig.keyConfigured).toBe(true);
      expect(publicConfig.apiKey).toBeUndefined();
      await platform.close();
      platformClosed = true;
      const restarted = await startPlatform({ repoRoot: dir, dataDir: join(dir, "data"), port: 0 });
      try {
        const restored = (await fetch(
          `http://127.0.0.1:${restarted.port}/api/agents/${agent.id}/sessions/${chatSessionId}/messages`,
        ).then((response) => response.json())) as typeof history;
        expect(restored.some((message) => message.text.includes("Platform response"))).toBe(true);
        const restoredIsolated = (await fetch(
          `http://127.0.0.1:${restarted.port}/api/agents/${agent.id}/sessions/${isolatedSession.id}/messages`,
        ).then((response) => response.json())) as typeof isolatedHistory;
        expect(restoredIsolated.some((message) => message.text === "Second conversation")).toBe(true);
      } finally {
        await restarted.close();
      }
    } finally {
      if (!platformClosed) await platform.close();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });
});
