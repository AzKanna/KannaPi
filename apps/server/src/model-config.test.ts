import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ModelConfigStore } from "./model-config.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => item()));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-model-config-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return new ModelConfigStore(join(dir, "models.json"), join(dir, "auth.json"), join(dir, "active.json"));
}

describe("ModelConfigStore model discovery", () => {
  test("discovers and normalizes OpenAI-compatible model lists", async () => {
    let authorization = "";
    let requestedPath = "";
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization ?? "");
      requestedPath = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            { id: "z-model", owned_by: "lab" },
            { id: "a-model", name: "A Model" },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server failed to bind");

    const store = await fixture();
    const models = await store.discover({
      baseUrl: `http://127.0.0.1:${address.port}/v1/`,
      apiKey: "draft-secret",
    });

    expect(requestedPath).toBe("/v1/models");
    expect(authorization).toBe("Bearer draft-secret");
    expect(models).toEqual([
      { id: "a-model", name: "A Model" },
      { id: "z-model", name: "z-model", ownedBy: "lab" },
    ]);
  });

  test("reuses a saved key without returning it", async () => {
    let authorization = "";
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "saved-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server failed to bind");

    const store = await fixture();
    await store.save({
      providerId: "saved",
      providerName: "Saved",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: "saved-model",
      modelName: "Saved model",
      apiKey: "stored-secret",
    });
    expect(
      await store.discover({ providerId: "saved", baseUrl: `http://127.0.0.1:${address.port}/v1` }),
    ).toEqual([{ id: "saved-model", name: "saved-model" }]);
    expect(authorization).toBe("Bearer stored-secret");
    expect(await readFile(store.authPath, "utf8")).toContain("stored-secret");
  });

  test("persists DeepSeek thinking strength and exposes supported levels", async () => {
    const store = await fixture();
    const saved = await store.save({
      providerId: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-flash",
      modelName: "DeepSeek Flash",
      apiKey: "test-secret",
      thinkingLevel: "high",
    });

    expect(saved).toMatchObject({ reasoning: true, thinkingLevel: "high" });
    expect((await store.list())[0]).toMatchObject({
      modelId: "deepseek-flash",
      reasoning: true,
      thinkingLevels: ["off", "low", "high", "max"],
    });
    const models = JSON.parse(await readFile(store.modelsPath, "utf8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers.deepseek?.models[0]).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { low: "low", medium: "high", high: "high", max: "max" },
      compat: { supportsReasoningEffort: true, thinkingFormat: "deepseek" },
    });

    const disabled = await store.save({
      providerId: "deepseek",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      modelName: "DeepSeek Flash",
      thinkingLevel: "off",
    });
    expect(disabled).toMatchObject({ reasoning: true, thinkingLevel: "off" });
  });

  test("does not include remote response bodies in errors", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "secret remote detail" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server failed to bind");

    const store = await fixture();
    await expect(
      store.discover({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "bad" }),
    ).rejects.toThrow("Model discovery failed (401 Unauthorized)");
  });
});
