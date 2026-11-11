import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ProxyEvent } from "@kanna/shared";
import { IngestServer } from "./ingest-server.js";

let server: IngestServer;
const received: ProxyEvent[] = [];
const invalid: string[] = [];

beforeAll(async () => {
  server = new IngestServer({
    port: 0,
    onProxyEvent: (ev) => received.push(ev),
    onInvalidMessage: (msg) => invalid.push(msg),
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

function send(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.ingestUrl);
    ws.on("open", () => {
      ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      ws.close();
      resolve();
    });
    ws.on("error", reject);
  });
}

describe("IngestServer", () => {
  it("starts on an ephemeral port and exposes the ingest URL", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.ingestUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/proxy$/);
  });

  it("delivers valid proxy events to the handler", async () => {
    await send({
      v: 1,
      kind: "addon_ready",
      addonVersion: "0.1.0",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("addon_ready");
  });

  it("sends interception commands to the connected addon", async () => {
    const ws = new WebSocket(server.ingestUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const receivedCommand = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
    });
    expect(server.sendProxyCommand({ kind: "intercept_mode", enabled: true })).toBe(true);
    await expect(receivedCommand).resolves.toEqual({ kind: "intercept_mode", enabled: true });
    ws.close();
  });

  it("rejects non-JSON messages", async () => {
    await send("this is not json");
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getInvalidCount()).toBe(1);
  });

  it("rejects well-formed JSON that is not a proxy event", async () => {
    await send({ hello: "world" });
    await send({ v: 1, kind: "flow_start", flowKey: "x" }); // missing required fields
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getInvalidCount()).toBe(3);
    expect(invalid.every((m) => m.length > 0)).toBe(true);
  });
});
