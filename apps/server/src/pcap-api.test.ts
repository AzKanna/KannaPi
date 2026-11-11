import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startPlatform } from "./platform.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

function emptyCapture(): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(1, 20);
  return header;
}

describe("PCAP workspace API", () => {
  test.skipIf(!process.env.KANNAPI_TEST_TSHARK_PATH)("uses its configured TShark executable for project captures", async () => {
    const folder = await mkdtemp(join(tmpdir(), "kanna-pcap-tshark-api-"));
    folders.push(folder);
    const platform = await startPlatform({ repoRoot: folder, dataDir: join(folder, "data"), port: 0,
      tsharkPath: process.env.KANNAPI_TEST_TSHARK_PATH });
    const base = `http://127.0.0.1:${platform.port}`;
    try {
      const project = (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "PCAP lab", workspacePath: folder }) }).then((response) => response.json())) as { id: string };
      const response = await fetch(`${base}/api/projects/${project.id}/pcap`, { method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": "empty.pcap" }, body: emptyCapture() });
      expect(response.status).toBe(201);
      expect((await response.json()).tshark).toMatchObject({ status: "used", httpRecords: 0 });
    } finally {
      await platform.close();
    }
  });

  test("uploads, lists, and loads captures for the selected project", async () => {
    const folder = await mkdtemp(join(tmpdir(), "kanna-pcap-api-"));
    folders.push(folder);
    const platform = await startPlatform({ repoRoot: folder, dataDir: join(folder, "data"), port: 0 });
    const base = `http://127.0.0.1:${platform.port}`;
    try {
      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "PCAP lab", workspacePath: folder }),
      });
      const project = (await created.json()) as { id: string };
      expect(created.status).toBe(201);
      const imported = await fetch(`${base}/api/projects/${project.id}/pcap`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent("sample.pcap"),
        },
        body: emptyCapture(),
      });
      expect(imported.status).toBe(201);
      const report = (await imported.json()) as { id: string; packetCount: number };
      expect(report.packetCount).toBe(0);
      expect(
        (
          (await fetch(`${base}/api/projects/${project.id}/pcap`).then((response) =>
            response.json(),
          )) as Array<{ id: string }>
        )[0]?.id,
      ).toBe(report.id);
      expect((await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}`)).status).toBe(200);
      const keyLog = Buffer.from(`CLIENT_TRAFFIC_SECRET_0 ${"11".repeat(32)} ${"22".repeat(32)}\n`);
      const applied = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/tls-keylog`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: keyLog,
      });
      expect(applied.status).toBe(200);
      expect(((await applied.json()) as { id: string }).id).toBe(report.id);
      const invalidKeyLog = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/tls-keylog`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "bad key log",
      });
      expect(invalidKeyLog.status).toBe(400);
      const withoutReview = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: "overview" }),
      });
      expect(withoutReview.status).toBe(400);
      expect(((await withoutReview.json()) as { error: string }).error).toMatch(/confirm/i);
    } finally {
      await platform.close();
    }
  });

  test("sends only a confirmed capture summary to the selected project Agent", async () => {
    const folder = await mkdtemp(join(tmpdir(), "kanna-pcap-agent-"));
    folders.push(folder);
    const prompts: string[] = [];
    const fake = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        prompts.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"id":"fake","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Capture reviewed."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("Fake model did not start");
    const platform = await startPlatform({ repoRoot: folder, dataDir: join(folder, "data"), port: 0 });
    const base = `http://127.0.0.1:${platform.port}`;
    const json = (body: object) => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      await fetch(`${base}/api/model-config`, {
        method: "POST",
        ...json({
          providerId: "fixture",
          providerName: "Fixture",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: "fixture",
          modelName: "Fixture",
          apiKey: "fixture",
        }),
      });
      const project = (await fetch(`${base}/api/projects`, {
        method: "POST",
        ...json({ name: "PCAP lab", workspacePath: folder }),
      }).then((response) => response.json())) as { id: string };
      const agent = (await fetch(`${base}/api/projects/${project.id}/agents`, {
        method: "POST",
        ...json({ name: "PCAP analyst", toolProfile: "chat" }),
      }).then((response) => response.json())) as { id: string };
      const capture = emptyCapture();
      const report = (await fetch(`${base}/api/projects/${project.id}/pcap`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": "review.pcap" },
        body: capture,
      }).then((response) => response.json())) as { id: string };
      const unconfirmedFile = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/analyze`, {
        method: "POST", ...json({ agentId: agent.id, selection: "overview", confirmed: true, includeOriginalCapture: true }),
      });
      expect(unconfirmedFile.status).toBe(400);
      expect((await unconfirmedFile.json() as { error: string }).error).toMatch(/original|confirm/i);
      const chatFile = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/analyze`, {
        method: "POST", ...json({ agentId: agent.id, selection: "overview", confirmed: true,
          includeOriginalCapture: true, confirmOriginalCapture: true }),
      });
      expect(chatFile.status).toBe(400);
      expect((await chatFile.json() as { error: string }).error).toMatch(/file-reading tools/i);
      const sent = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/analyze`, {
        method: "POST",
        ...json({ agentId: agent.id, selection: "overview", confirmed: true }),
      });
      expect(sent.status).toBe(202);
      for (
        let attempt = 0;
        attempt < 40 && !prompts.some((prompt) => prompt.includes("offline PCAP evidence"));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(prompts.some((prompt) => prompt.includes("review.pcap"))).toBe(true);
      const toolAgent = (await fetch(`${base}/api/projects/${project.id}/agents`, {
        method: "POST", ...json({ name: "PCAP tool analyst", toolProfile: "read-only" }),
      }).then((response) => response.json())) as { id: string };
      const before = prompts.length;
      const original = await fetch(`${base}/api/projects/${project.id}/pcap/${report.id}/analyze`, {
        method: "POST", ...json({ agentId: toolAgent.id, selection: "overview", confirmed: true,
          includeOriginalCapture: true, confirmOriginalCapture: true }),
      });
      expect(original.status).toBe(202);
      for (let attempt = 0; attempt < 40 && prompts.length <= before; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(prompts.slice(before).some((prompt) => prompt.includes("<kanna-attachment-context>"))).toBe(true);
      const attachment = platform.runtime.attachments.list(toolAgent.id)[0];
      expect(attachment?.name).toBe("review.pcap");
      expect((await platform.runtime.readAttachment(toolAgent.id, attachment!.id)).bytes).toEqual(capture);
    } finally {
      await platform.close();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});
