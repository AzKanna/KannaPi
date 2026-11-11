import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChatMessage, KannaEvent } from "@kanna/shared";
import { expect, test, vi } from "vitest";
import WebSocket from "ws";
import { startPlatform } from "./platform.js";

test("Agent Chat delegates to independent Pi sessions, preserves sandbox access and restores results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanna-subagents-"));
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  let waitingChildren = 0,
    cancelledChildren = 0;
  const model = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const system =
        body.messages.find((message: { role: string }) => message.role === "system")?.content ?? "";
      const child = /independent (scout|worker) subagent/.test(system);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "subagent-model", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const answer = (text: string) => {
        send({ role: "assistant", content: text });
        send({}, "stop");
        response.end("data: [DONE]\n\n");
      };
      const tool = (name: string, args: object) => {
        send({ role: "assistant", content: "" });
        send({
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        send({}, "tool_calls");
        response.end("data: [DONE]\n\n");
      };
      if (system.includes("semantic execution graph")) {
        answer('{"nodes":[],"edges":[]}');
        return;
      }
      const latest = body.messages.at(-1);
      const latestText =
        typeof latest?.content === "string"
          ? latest.content
          : Array.isArray(latest?.content)
            ? latest.content.map((part: { text?: string }) => part.text ?? "").join("\n")
            : "";
      if (child) {
        if (latestText === "wait-for-cancel") {
          waitingChildren++;
          send({ role: "assistant", content: "Child is waiting." });
          response.on("close", () => {
            cancelledChildren++;
          });
          return;
        }
        if (system.includes("independent worker") && latest?.role !== "tool") {
          tool("write", { path: "delegated.txt", content: "verified worker artifact" });
          return;
        }
        answer(
          system.includes("independent worker")
            ? "Worker verified its artifact."
            : "Scout collected evidence.",
        );
      } else if (latest?.role === "user" && /delegate-normal|delegate-cancel/.test(latestText)) {
        const cancel = latestText === "delegate-cancel";
        tool("subagent", {
          tasks: [
            { agent: "scout", task: cancel ? "wait-for-cancel" : "Inspect the project independently." },
            { agent: "worker", task: cancel ? "wait-for-cancel" : "Write delegated.txt in the workspace." },
          ],
        });
      } else
        answer(
          latest?.role === "tool" ? "Merged evidence from both agents." : "Acknowledged parent-only history.",
        );
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("No model port");
  const platform = await startPlatform({ repoRoot: directory, dataDir: join(directory, "data"), port: 0 });
  const events: KannaEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${platform.port}/ui`);
  ws.on("message", (value) => events.push(JSON.parse(String(value))));
  await new Promise<void>((resolve) => ws.once("open", resolve));
  try {
    await platform.runtime.configureModel({
      providerId: "fake",
      providerName: "Fake",
      modelId: "subagent-model",
      modelName: "Subagent model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fake-model-key",
    });
    const project = platform.runtime.createProject({ name: "Multi-Agent", workspacePath: directory });
    const agent = platform.runtime.createAgent(project.id, { name: "Primary", toolProfile: "full" });
    const session = platform.runtime.listChatSessions(agent.id)[0]!;
    const turn = async (text: string) => {
      await platform.runtime.send(agent.id, text, "prompt", [], session.id);
      await vi.waitFor(() => expect(platform.runtime.agents.get(agent.id)?.status).toBe("idle"), {
        timeout: 10000,
      });
    };
    await turn("main-only-private-history");
    await turn("delegate-normal");
    const messages = await platform.runtime.messages(agent.id, session.id);
    const delegated = messages.find((message) => message.toolName === "subagent");
    expect(messages).toContainEqual(expect.objectContaining({ toolName: "subagent" }));
    expect(delegated?.isError).toBe(false);
    expect(delegated?.subagents?.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(delegated?.subagents?.[1]?.toolCount).toBe(1);
    const scout = requests.find((body) =>
      body.messages.some((message) => String(message.content ?? "").includes("independent scout subagent")),
    )!;
    const worker = requests.find((body) =>
      body.messages.some((message) => String(message.content ?? "").includes("independent worker subagent")),
    )!;
    const scoutTools = scout.tools?.map((tool) => tool.function.name) ?? [];
    const workerTools = worker.tools?.map((tool) => tool.function.name) ?? [];
    expect(scoutTools).toContain("read");
    for (const name of ["write", "sandbox_exec", "subagent", "bash", "powershell", "ssh_exec"])
      expect(scoutTools).not.toContain(name);
    expect(workerTools).toContain("write");
    expect(workerTools).toContain("sandbox_exec");
    for (const name of ["subagent", "powershell", "ssh_exec"]) expect(workerTools).not.toContain(name);
    expect(JSON.stringify(scout.messages)).not.toContain("main-only-private-history");
    expect(JSON.stringify(worker.messages)).not.toContain("main-only-private-history");
    expect(
      await readFile(join(directory, "data", "sandboxes", session.id, "workspace", "delegated.txt"), "utf8"),
    ).toBe("verified worker artifact");
    expect(await stat(join(directory, "delegated.txt")).catch(() => undefined)).toBeUndefined();
    expect(
      events.some(
        (event) => event.type === "agent_tool" && event.subagents?.some((item) => item.status === "running"),
      ),
    ).toBe(true);
    expect(
      events.filter(
        (event) => event.type === "agent_message" && event.message.text === "Scout collected evidence.",
      ),
    ).toHaveLength(0);
    await platform.runtime.configureRuntimeSettings(platform.runtime.runtimeSettings.get());
    const restored: AgentChatMessage[] = await platform.runtime.messages(agent.id, session.id);
    expect(restored.find((item) => item.toolName === "subagent")?.subagents).toEqual(delegated?.subagents);
    expect(JSON.stringify(restored)).not.toContain("fake-model-key");

    await platform.runtime.send(agent.id, "delegate-cancel", "prompt", [], session.id);
    await vi.waitFor(() => expect(waitingChildren).toBe(2));
    await platform.runtime.abort(agent.id, session.id);
    await vi.waitFor(() => expect(cancelledChildren).toBe(2));
    expect(platform.runtime.agents.get(agent.id)?.status).toBe("stopped");
    await turn("after-cancel");
    const settings = platform.runtime.runtimeSettings.get();
    await platform.runtime.configureRuntimeSettings({
      ...settings,
      multiAgent: { ...settings.multiAgent, enabled: false },
    });
    await turn("delegation-disabled");
    const normalRequest = requests
      .filter(
        (body) =>
          body.tools?.some((tool) => tool.function.name === "read") &&
          JSON.stringify(body.messages.at(-1)?.content).includes("delegation-disabled"),
      )
      .at(-1)!;
    expect(normalRequest.tools?.some((tool) => tool.function.name === "subagent")).toBe(false);
  } finally {
    ws.close();
    await platform.close();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);
