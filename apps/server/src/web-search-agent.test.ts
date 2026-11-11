import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentChatMessage } from "@kanna/shared";
import { expect, test, vi } from "vitest";
import { startPlatform } from "./platform.js";

test("Pi invokes web_search with sandbox networking off; API settings are local-only and chat stays tool-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanna-search-agent-"));
  const requests: Array<{
    tools?: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  const model = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "search-test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      const searchEnabled = body.tools?.some(
        (tool: { function: { name: string } }) => tool.function.name === "web_search",
      );
      if (searchEnabled && body.messages.at(-1)?.role !== "tool") {
        const web = JSON.stringify(body.messages.at(-1)?.content).includes("DeepSeek 搜索接口");
        send({ content: web ? "我先查询 DeepSeek 网页搜索。" : "我先查询 NVD 记录。" });
        send({
          tool_calls: [
            {
              index: 0,
              id: `search-${requests.length}`,
              type: "function",
              function: {
                name: "web_search",
                arguments: web
                  ? '{"query":"DeepSeek 搜索接口 site:api-docs.deepseek.com","mode":"web","maxResults":1}'
                  : '{"query":"CVE-2024-3094","mode":"cve","maxResults":1}',
              },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        const result = String(body.messages.at(-1)?.content);
        send({
          content: raw.includes("semantic execution graph")
            ? '{"nodes":[],"edges":[]}'
            : result.includes("disabled")
              ? "Web Search 已禁用。"
              : searchEnabled
                ? result.includes('"provider": "deepseek"')
                  ? "查询到了 DeepSeek 搜索接口：[DeepSeek](https://api-docs.deepseek.com/zh-cn/guides/search/)。"
                  : "查询到了 xz 记录：[NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-3094)。"
                : "纯对话，无工具。",
        });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("No model port");
  const actualFetch = globalThis.fetch;
  const nvd = vi.fn(async () =>
    Response.json({
      totalResults: 1,
      vulnerabilities: [
        { cve: { id: "CVE-2024-3094", descriptions: [{ lang: "en", value: "xz issue" }], references: [] } },
      ],
    }),
  );
  const deepseek = vi.fn(async () =>
    Response.json({
      results: [
        {
          title: "DeepSeek 搜索文档",
          url: "https://api-docs.deepseek.com/zh-cn/guides/search/",
          summary: "Search 接口返回结构化网页结果。",
          snippet: "搜索文档",
          content: "",
          date: null,
        },
      ],
    }),
  );
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((url, init) =>
      String(url).startsWith("https://services.nvd.nist.gov/")
        ? nvd()
        : String(url) === "https://api.deepseek.com/v1/tools/search"
          ? deepseek()
          : actualFetch(url, init),
    );
  const platform = await startPlatform({ repoRoot: directory, dataDir: join(directory, "data"), port: 0 });
  const base = `http://127.0.0.1:${platform.port}`;
  const json = (body: object) => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    await platform.runtime.webSearch.save({ clearDeepSeekKey: true, clearNvdKey: true });
    await platform.runtime.configureModel({
      providerId: "fake",
      providerName: "Fake",
      modelId: "search-model",
      modelName: "Search model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "model-test-secret",
    });
    const project = platform.runtime.createProject({ name: "Search", workspacePath: directory });
    const agent = platform.runtime.createAgent(project.id, { name: "Searcher", toolProfile: "full" });
    const session = platform.runtime.listChatSessions(agent.id)[0];
    if (!session) throw new Error("No default Session");
    expect(platform.runtime.runtimeSettings.get().sandbox).toEqual({ enabled: true, network: false });
    await platform.runtime.send(agent.id, "查询 CVE-2024-3094", "prompt", [], session.id);
    let messages: AgentChatMessage[] = [];
    await vi.waitFor(async () => {
      messages = await platform.runtime.messages(agent.id, session.id);
      expect(
        messages.some((message) => message.role === "assistant" && message.text.includes("查询到了")),
      ).toBe(true);
    });
    const tool = messages.find((message) => message.toolName === "web_search");
    expect(tool?.isError).toBe(false);
    expect(tool?.text).toContain("UNTRUSTED SEARCH DATA");
    expect(tool?.text).toContain("https://nvd.nist.gov/vuln/detail/CVE-2024-3094");
    const names = requests[0]?.tools?.map((tool) => tool.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("sandbox_exec");
    for (const forbidden of ["powershell", "bash", "ssh_exec"]) expect(names).not.toContain(forbidden);
    expect(nvd).toHaveBeenCalledTimes(1);
    const settings = await actualFetch(`${base}/api/web-search/settings`, {
      method: "PUT",
      ...json({ deepseekApiKey: "private-search-key" }),
    });
    expect(settings.status).toBe(200);
    expect(await settings.text()).not.toContain("private-search-key");
    const rejected = await actualFetch(`${base}/api/web-search/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: '{"enabled":false}',
    });
    expect(rejected.status).toBe(400);
    expect(
      (
        await actualFetch(`${base}/api/web-search/test`, {
          method: "POST",
          ...json({ query: "a", maxResults: 100 }),
        })
      ).status,
    ).toBe(400);
    const preview = await actualFetch(`${base}/api/web-search/test`, {
      method: "POST",
      ...json({ query: "CVE-2024-3094", mode: "cve", maxResults: 1 }),
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()).cached).toBe(false);
    await platform.runtime.send(agent.id, "使用网页搜索查询 DeepSeek 搜索接口", "prompt", [], session.id);
    await vi.waitFor(async () => {
      messages = await platform.runtime.messages(agent.id, session.id);
      expect(
        messages.some(
          (message) => message.role === "assistant" && message.text.includes("查询到了 DeepSeek"),
        ),
      ).toBe(true);
    });
    expect(deepseek).toHaveBeenCalledTimes(1);
    const webTool = messages.find(
      (message) => message.toolName === "web_search" && message.text.includes('"provider": "deepseek"'),
    );
    expect(webTool?.isError).toBe(false);
    expect(webTool?.text).toContain("Search 接口返回结构化网页结果");
    expect(webTool?.text).not.toContain("private-search-key");
    await platform.runtime.webSearch.save({ enabled: false });
    await platform.runtime.send(agent.id, "再次查询 CVE-2024-3094", "prompt", [], session.id);
    await vi.waitFor(async () =>
      expect(
        (await platform.runtime.messages(agent.id, session.id)).some(
          (message) => message.text === "Web Search 已禁用。",
        ),
      ).toBe(true),
    );
    expect(nvd).toHaveBeenCalledTimes(2);
    const chat = platform.runtime.createAgent(project.id, { name: "Chat", toolProfile: "chat" });
    const chatSession = platform.runtime.listChatSessions(chat.id)[0];
    if (!chatSession) throw new Error("No default chat Session");
    await platform.runtime.send(chat.id, "Hello", "prompt", [], chatSession.id);
    await vi.waitFor(async () =>
      expect(
        (await platform.runtime.messages(chat.id)).some((message) => message.text === "纯对话，无工具。"),
      ).toBe(true),
    );
    expect(requests.at(-1)?.tools?.length ?? 0).toBe(0);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("model-test-secret");
    expect(serialized).not.toContain("private-search-key");
    expect(JSON.stringify(requests)).not.toContain("private-search-key");
  } finally {
    await platform.close();
    spy.mockRestore();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
