import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContextStatus, AgentRuntimeSettings, KannaEvent } from "@kanna/shared";
import { DEFAULT_AGENT_RUNTIME_SETTINGS } from "@kanna/shared";
import { expect, test } from "vitest";
import WebSocket from "ws";
import { startPlatform } from "./platform.js";
import { RuntimeSettingsStore } from "./runtime-settings.js";

const checkpoint =
  "# CHECKPOINT\nGoal: continue the user's analysis. Verified: previous turns saved. Next: inspect the next input.";
async function fixture(automatic: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "kanna-runtime-"));
  const requests: Array<{
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  let failSummary = false,
    slowSummary = false;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(text);
      requests.push(body);
      const summary = text.includes("<conversation>");
      if (summary && failSummary) {
        response.writeHead(401);
        response.end(JSON.stringify({ error: { message: "Summary rejected" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = () => {
        const content = summary
          ? checkpoint
          : text.includes("semantic execution graph")
            ? '{"nodes":[],"edges":[]}'
            : "Answer " + "verified finding. ".repeat(100);
        response.write(
          `data: ${JSON.stringify({ id: "chat-runtime", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "chat-runtime", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: automatic && !summary ? 7000 : 1200, completion_tokens: 300, total_tokens: automatic && !summary ? 7300 : 1500 } })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      };
      if (summary && slowSummary) {
        const timer = setTimeout(send, 3000);
        response.on("close", () => clearTimeout(timer));
      } else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fake port");
  const settings: AgentRuntimeSettings = {
    ...structuredClone(DEFAULT_AGENT_RUNTIME_SETTINGS),
    compaction: { enabled: automatic, thresholdPercent: 80, keepRecentTokens: 256 },
  };
  const platform = await startPlatform({
    repoRoot: directory,
    dataDir: join(directory, "data"),
    port: 0,
    runtimeSettings: settings,
  });
  await platform.runtime.configureModel({
    providerId: "fake",
    providerName: "Fake",
    modelId: "runtime-model",
    modelName: "Runtime model",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "test-only",
    contextWindow: 8192,
    maxTokens: 1024,
  });
  const project = platform.runtime.createProject({ name: "Runtime test", workspacePath: directory });
  const agent = platform.runtime.createAgent(project.id, { name: "Runtime", toolProfile: "full" });
  const session = platform.runtime.listChatSessions(agent.id)[0]!;
  const events: KannaEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${platform.port}/ui`);
  ws.on("message", (message) => events.push(JSON.parse(String(message))));
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return {
    directory,
    platform,
    agent,
    session,
    requests,
    events,
    base: `http://127.0.0.1:${platform.port}`,
    failSummary: () => {
      failSummary = true;
    },
    slowSummary: () => {
      slowSummary = true;
    },
    async close() {
      ws.close();
      await platform.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
async function turn(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  await f.platform.runtime.send(f.agent.id, text, "prompt", [], f.session.id);
  await expect.poll(() => f.platform.runtime.agents.get(f.agent.id)?.status, { timeout: 10000 }).toBe("idle");
}

test("persists validated runtime settings and fails closed on corrupted settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanna-settings-"));
  try {
    const path = join(directory, "settings.json");
    const store = new RuntimeSettingsStore(path);
    await store.load();
    expect(store.get().sandbox.enabled).toBe(true);
    await store.save({ ...store.get(), sandbox: { enabled: true, network: true } });
    const resumed = new RuntimeSettingsStore(path);
    await resumed.load();
    expect(resumed.get().sandbox.network).toBe(true);
    await expect(
      store.save({
        ...store.get(),
        compaction: { enabled: true, thresholdPercent: 100, keepRecentTokens: 256 },
      }),
    ).rejects.toThrow("50–95");
    expect(JSON.parse(await readFile(path, "utf8")).compaction.thresholdPercent).toBe(80);
    await expect(store.save({ ...store.get(), multiAgent: { enabled: true, maxConcurrency: 8, timeoutMinutes: 10 } })).rejects.toThrow("1–4");
    const { multiAgent: _multiAgent, ...legacy } = store.get();
    await writeFile(path, JSON.stringify(legacy));
    const migrated = new RuntimeSettingsStore(path);
    await migrated.load();
    expect(migrated.get().multiAgent).toEqual(DEFAULT_AGENT_RUNTIME_SETTINGS.multiAgent);
    await writeFile(path, "invalid JSON");
    await expect(new RuntimeSettingsStore(path).load()).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual compression preserves display history, resumes from summary and exposes isolated tools only", async () => {
  const f = await fixture(false);
  try {
    for (let index = 0; index < 3; index++)
      await turn(f, `old-turn-${index}: ` + "input observation. ".repeat(120));
    const before = await f.platform.runtime.messages(f.agent.id, f.session.id);
    const denied = await fetch(`${f.base}/api/runtime-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify(DEFAULT_AGENT_RUNTIME_SETTINGS),
    });
    expect(denied.ok).toBe(false);
    const response = await fetch(`${f.base}/api/agents/${f.agent.id}/sessions/${f.session.id}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const context = (await response.json()) as AgentContextStatus;
    expect(context.lastCompaction?.summary).toContain("CHECKPOINT");
    expect(context.compactions).toBe(1);
    expect(context.compacting).toBe(false);
    expect(context.tokens).toBeNull();
    expect(await f.platform.runtime.messages(f.agent.id, f.session.id)).toEqual(before);
    await turn(f, "Continue from the checkpoint.");
    const next = f.requests.find((request) =>
      JSON.stringify(request.messages).includes("Continue from the checkpoint."),
    );
    expect(JSON.stringify(next?.messages)).toContain("CHECKPOINT");
    expect(JSON.stringify(next?.messages)).not.toContain("old-turn-0:");
    const tools = f.requests[0]!.tools!.map((tool) => tool.function.name);
    expect(tools).toContain("sandbox_exec");
    expect(tools).not.toContain("powershell");
    expect(tools).not.toContain("bash");
    expect(tools.some((name) => name.startsWith("ssh"))).toBe(false);
    const saved = await readFile(
      f.platform.runtime.chatSessions.get(f.agent.id, f.session.id)!.piSessionFile!,
      "utf8",
    );
    expect(saved).toContain('"type":"compaction"');
    expect(saved).toContain("old-turn-0:");
    await f.platform.runtime.configureRuntimeSettings({
      ...DEFAULT_AGENT_RUNTIME_SETTINGS,
      compaction: { enabled: false, thresholdPercent: 80, keepRecentTokens: 256 },
    });
    expect(
      (await f.platform.runtime.contextStatus(f.agent.id, f.session.id)).lastCompaction?.summary,
    ).toContain("CHECKPOINT");
    expect(
      (await f.platform.runtime.messages(f.agent.id, f.session.id)).some((message) =>
        message.text.includes("old-turn-0:"),
      ),
    ).toBe(true);
    expect(f.events.some((event) => event.type === "agent_context" && event.context.compacting)).toBe(true);
  } finally {
    await f.close();
  }
});

test("automatically compacts at configured context threshold", async () => {
  const f = await fixture(true);
  try {
    await turn(f, "A long initial observation. ".repeat(150));
    await expect
      .poll(async () => (await f.platform.runtime.contextStatus(f.agent.id, f.session.id)).compactions)
      .toBe(1);
    expect(f.requests.some((request) => JSON.stringify(request).includes("<conversation>"))).toBe(true);
    expect(
      (await f.platform.runtime.messages(f.agent.id, f.session.id)).some(
        (message) => message.role === "user",
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("rejects concurrent compression/mutations and cancellation leaves original history intact", async () => {
  const f = await fixture(false);
  try {
    await turn(f, "Observation. ".repeat(180));
    await turn(f, "More input. ".repeat(180));
    const before = await f.platform.runtime.messages(f.agent.id, f.session.id);
    f.slowSummary();
    const compact = f.platform.runtime.compactContext(f.agent.id, f.session.id).catch((error) => error);
    await expect
      .poll(() => f.events.some((event) => event.type === "agent_context" && event.context.compacting))
      .toBe(true);
    await expect(f.platform.runtime.send(f.agent.id, "race", "prompt", [], f.session.id)).rejects.toThrow(
      "compression",
    );
    await expect(f.platform.runtime.compactContext(f.agent.id, f.session.id)).rejects.toThrow("finish");
    await expect(f.platform.runtime.configureRuntimeSettings(DEFAULT_AGENT_RUNTIME_SETTINGS)).rejects.toThrow(
      "finish",
    );
    await f.platform.runtime.abort(f.agent.id, f.session.id);
    expect(await compact).toBeInstanceOf(Error);
    expect((await f.platform.runtime.contextStatus(f.agent.id, f.session.id)).compacting).toBe(false);
    expect(await f.platform.runtime.messages(f.agent.id, f.session.id)).toEqual(before);
  } finally {
    await f.close();
  }
});

test("failed compression does not erase history or leave the Session busy", async () => {
  const f = await fixture(false);
  try {
    await turn(f, "Observation. ".repeat(180));
    await turn(f, "More input. ".repeat(180));
    const before = await f.platform.runtime.messages(f.agent.id, f.session.id);
    f.failSummary();
    await expect(f.platform.runtime.compactContext(f.agent.id, f.session.id)).rejects.toThrow();
    const context = await f.platform.runtime.contextStatus(f.agent.id, f.session.id);
    expect(context.compacting).toBe(false);
    expect(context.error).toBeTruthy();
    expect(context.compactions).toBe(0);
    expect(await f.platform.runtime.messages(f.agent.id, f.session.id)).toEqual(before);
  } finally {
    await f.close();
  }
});
