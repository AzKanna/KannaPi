// Run after `pnpm build` and `pnpm --filter @kanna/web preview --host 127.0.0.1 --port 4173`.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const graph = (sessionId, title) => ({
  agentId: "a1", sessionId, runId: `run_${sessionId}`,
  status: "completed", startedAt: 1, completedAt: 2,
  nodes: [
    { id: "n1", kind: "objective", title, status: "completed", timestamp: 1 },
    { id: "n2", kind: "outcome", title: "Flag found", status: "completed", timestamp: 2 },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2" }],
});

const summary = {
  id: "bss_1", projectId: "p1", agentId: "a1", runId: "r1",
  challengeCode: "web_001", status: "solved", createdAt: 1,
  updatedAt: 2, messageCount: 3, hasGraph: true,
};

const responses = {
  "/api/projects": [{ id: "p1", name: "Bench Project", workspacePath: "C:/bench", createdAt: 1, updatedAt: 1 }],
  "/api/model-config": { configured: true, keyConfigured: true },
  "/api/models": [],
  "/api/projects/p1/assets": [],
  "/api/projects/p1/agents": [{
    id: "a1", projectId: "p1", name: "Test Agent", providerId: "demo", modelId: "demo",
    thinkingLevel: "medium", cwd: "C:/bench", systemPrompt: "", toolProfile: "full",
    status: "idle", createdAt: 1, updatedAt: 1,
  }],
  "/api/agents/a1/sessions": [{ id: "chat_1", agentId: "a1", name: "Main session", workspacePath: "C:/bench", createdAt: 1, updatedAt: 1 }],
  "/api/agents/a1/capabilities": { skills: [], mcpServers: [] },
  "/api/agents/a1/attack-graph": null,
  "/api/agents/a1/sessions/chat_1/messages": [],
  "/api/agents/a1/sessions/chat_1/attack-graph": graph("chat_1", "Chat objective"),
  "/api/projects/p1/bench/sessions": [summary],
  "/api/projects/p1/bench/sessions/bss_1": {
    ...summary,
    messages: [
      { id: "m1", role: "user", text: "Solve web_001", at: 1 },
      { id: "m2", role: "tool", text: "Result: flag", toolName: "powershell", phase: "completed", at: 2 },
      { id: "m3", role: "assistant", text: "Found a flag", at: 3 },
    ],
    graph: graph("bss_1", "Bench objective"),
  },
  "/api/projects/p1/bench/runs": [],
  "/api/bench/settings": { baseUrl: "https://example.test", tokenConfigured: true, sdkVersion: "test" },
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: Object.hasOwn(responses, path) ? responses[path] : {} });
  });
  await page.goto("http://127.0.0.1:4173/?workspace=bench");
  await page.locator(".sidebar-bench-list button").waitFor();
  await page.locator(".sidebar-bench-toggle").click();
  assert.equal(await page.locator(".sidebar-bench-list").count(), 0);
  await page.locator(".sidebar-bench-toggle").click();
  await page.locator(".sidebar-bench-list button").first().click();
  await page.locator(".bench-session-message.assistant").waitFor();
  assert.equal(await page.locator(".bench-session-card.expanded").count(), 1);
  await page.getByRole("button", { name: "View graph" }).click();
  await page.locator(".graph-node").first().waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".graph-session-picker select").inputValue(), "bss_1");
  assert.equal(await page.locator(".graph-node h2").first().innerText(), "Bench objective");
  await page.locator(".graph-session-picker select").selectOption("chat_1");
  await page.getByRole("heading", { name: "Chat objective" }).waitFor();
  assert.equal(await page.locator(".graph-node h2").first().innerText(), "Chat objective");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator(".workbench-nav button").filter({ hasText: "Bench Mode" }).click();
  await page.setViewportSize({ width: 460, height: 800 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".bench-workspace").evaluate((element) => element.scrollWidth > element.clientWidth), false);
  assert.deepEqual(pageErrors, []);
  console.log("Bench session UI smoke passed");
} finally {
  await browser.close();
}
