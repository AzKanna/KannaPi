import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalManager, AuditLogger, PolicyEngine, RateLimiter, ToolGuard } from "@kanna/security";
import type { KannaEvent } from "@kanna/shared";
import { defaultLocalScope } from "@kanna/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGeneralAgentSession,
  createKannaAgentSession,
  createKannaTools,
  normalizeAgentMessage,
  TOOL_PROFILES,
} from "./index.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fakeModelServer() {
  const requests: Array<{ tools: string[]; system: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content?: string }>;
        tools: Array<{ function: { name: string } }>;
      };
      const hasToolResult = parsed.messages.some((message) => message.role === "tool");
      requests.push({
        tools: parsed.tools.map((tool) => tool.function.name),
        system: parsed.messages.find((message) => message.role === "system")?.content ?? "",
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-kanna", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      if (!hasToolResult) {
        send({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "security_observe", arguments: "{}" },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ content: "Kanna session complete" });
        send({}, "stop");
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake model did not bind");
  return { server, port: address.port, requests };
}

async function fakeChatServer() {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finishReason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-general", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      chunk({ role: "assistant", content: "" });
      chunk({ content: "General Agent ready" });
      chunk({}, "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake chat model did not bind");
  return { server, port: address.port, requests };
}

describe("Pi SDK facade", () => {
  test("keeps Pi toolResult messages in chat history as tool calls", () => {
    expect(normalizeAgentMessage({
      role: "toolResult",
      toolCallId: "call_read_1",
      toolName: "read",
      content: [{ type: "text", text: "note content" }],
      isError: false,
      timestamp: 1_000,
    })).toMatchObject({ role: "tool", toolCallId: "call_read_1", toolName: "read", text: "note content", isError: false });
  });
  test("uses the native platform shell in the full tool profile", () => {
    const shell = process.platform === "win32" ? "powershell" : "bash";
    expect(TOOL_PROFILES.full).toContain(shell);
    if (process.platform === "win32") expect(TOOL_PROFILES.full).not.toContain("bash");
  });

  test("runs a deterministic tool loop with only the 15 custom tools and persists a resumable session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-agent-"));
    dirs.push(dir);
    await mkdir(join(dir, "sessions"));
    const fake = await fakeModelServer();
    const modelsPath = join(dir, "models.json");
    const authPath = join(dir, "auth.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fake: {
            name: "Fake",
            baseUrl: `http://127.0.0.1:${fake.port}/v1`,
            api: "openai-completions",
            models: [
              {
                id: "fake-model",
                name: "Fake Model",
                contextWindow: 32_000,
                maxTokens: 1024,
                input: ["text"],
              },
            ],
          },
        },
      }),
    );
    const observe = vi.fn(() => ({ state: { sessionId: "sess_1" }, counts: {} }));
    const guard = new ToolGuard({
      scope: defaultLocalScope([3000]),
      policy: new PolicyEngine(),
      rateLimiter: new RateLimiter(100),
      approvals: new ApprovalManager(async () => "denied"),
      audit: new AuditLogger({ append: () => undefined }),
    });
    const tools = createKannaTools({
      sessionId: "sess_1",
      guard,
      browser: {
        navigate: vi.fn(),
        click: vi.fn(),
        type: vi.fn(),
        pressKey: vi.fn(),
        back: vi.fn(),
        reload: vi.fn(),
        screenshot: vi.fn(),
        getPage: vi.fn(),
      },
      flows: { list: vi.fn(), getDetail: vi.fn(), recent: vi.fn(() => []), listByAction: vi.fn(() => []) },
      state: { compactSnapshot: observe },
      findings: { report: vi.fn() },
      searchTraffic: vi.fn(),
    });
    const events: KannaEvent[] = [];
    const agent = await createKannaAgentSession({
      cwd: dir,
      agentDir: dir,
      modelsPath,
      authPath,
      providerId: "fake",
      modelId: "fake-model",
      apiKey: "fake-key",
      tools,
      sessionDir: join(dir, "sessions"),
      emit: (event) => events.push(event),
    });
    try {
      expect(agent.session.getActiveToolNames()).toEqual(tools.map((tool) => tool.name));
      await agent.session.prompt("Inspect the state");
      await agent.waitUntilIdle();
      expect(observe).toHaveBeenCalledOnce();
      expect(
        fake.requests.every(
          (request) =>
            request.tools.length === 15 &&
            request.tools.every((name) => !["read", "bash", "edit", "write"].includes(name)),
        ),
      ).toBe(true);
      expect(fake.requests[0]?.system).toMatch(/untrusted data/i);
      expect(events.some((event) => event.type === "agent")).toBe(true);
    } finally {
      agent.dispose();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
    expect((await readdir(join(dir, "sessions"))).some((name) => name.endsWith(".jsonl"))).toBe(true);
  }, 30_000);

  test("creates a persistent general Agent with an explicit read-only tool profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-general-agent-"));
    dirs.push(dir);
    await mkdir(join(dir, "sessions"));
    const fake = await fakeChatServer();
    const modelsPath = join(dir, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fake: {
            name: "Fake",
            baseUrl: `http://127.0.0.1:${fake.port}/v1`,
            api: "openai-completions",
            models: [
              {
                id: "fake-model",
                name: "Fake Model",
                reasoning: true,
                thinkingLevelMap: { off: "none", high: "high", max: "max" },
                contextWindow: 32_000,
                maxTokens: 1024,
                input: ["text"],
                compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek" },
              },
            ],
          },
        },
      }),
    );
    const events: unknown[] = [];
    const agent = await createGeneralAgentSession({
      cwd: dir,
      agentDir: dir,
      modelsPath,
      authPath: join(dir, "auth.json"),
      providerId: "fake",
      modelId: "fake-model",
      thinkingLevel: "high",
      apiKey: "fake-key",
      toolProfile: "read-only",
      sessionDir: join(dir, "sessions"),
      onEvent: (event) => events.push(event),
    });
    try {
      expect(agent.session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls"]);
      expect(agent.session.thinkingLevel).toBe("high");
      await agent.session.prompt("Hello");
      expect(fake.requests[0]).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      });
      agent.session.setThinkingLevel("off");
      await agent.session.prompt("Again without thinking");
      expect(fake.requests[1]).toMatchObject({ thinking: { type: "disabled" } });
      expect(fake.requests[1]?.reasoning_effort).toBeUndefined();
      const messages = agent.session.state.messages.flatMap(
        (message) => normalizeAgentMessage(message) ?? [],
      );
      expect(messages.at(-1)?.text).toContain("General Agent ready");
      expect(events.some((event) => (event as { type?: string }).type === "agent_settled")).toBe(true);
    } finally {
      agent.dispose();
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
    expect((await readdir(join(dir, "sessions"))).some((name) => name.endsWith(".jsonl"))).toBe(true);
  }, 30_000);

  test("loads only explicit Pi Plugins for a Full non-sandboxed Agent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-pi-plugin-"));
    dirs.push(dir);
    await mkdir(join(dir, "sessions"));
    const fake = await fakeChatServer();
    const modelsPath = join(dir, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { fake: {
      name: "Fake", baseUrl: `http://127.0.0.1:${fake.port}/v1`, api: "openai-completions",
      models: [{ id: "fake-model", name: "Fake Model", reasoning: false, contextWindow: 32_000, maxTokens: 1024, input: ["text"] }],
    } } }));
    const pluginPath = join(dir, "echo.mjs");
    await writeFile(pluginPath, `export default (pi) => { pi.registerTool({ name: "plugin_echo", label: "Plugin Echo", description: "Echo via Pi Plugin", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "plugin works" }] }; } }); };`);
    const base = { cwd: dir, agentDir: dir, modelsPath, authPath: join(dir, "auth.json"), providerId: "fake", modelId: "fake-model", apiKey: "fake-key", sessionDir: join(dir, "sessions"), persistence: "memory" as const };
    try {
      const limited = await createGeneralAgentSession({ ...base, toolProfile: "read-only", pluginPaths: [pluginPath] });
      expect(limited.session.getActiveToolNames()).not.toContain("plugin_echo");
      await limited.dispose();

      const full = await createGeneralAgentSession({ ...base, toolProfile: "full", pluginPaths: [pluginPath] });
      try {
        expect(full.session.getActiveToolNames()).toContain("plugin_echo");
        await full.session.prompt("Hello");
        expect((fake.requests.at(-1)?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toContain("plugin_echo");
      } finally { await full.dispose(); }
    } finally { await new Promise<void>((resolve) => fake.server.close(() => resolve())); }
  }, 30_000);
});
