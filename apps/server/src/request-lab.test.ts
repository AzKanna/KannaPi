import {
  AuditRepo,
  BodyStore,
  FlowsRepo,
  openDatabase,
  ProjectsRepo,
  RequestLabRepo,
  SessionsRepo,
} from "@kanna/database";
import { newId, type TrafficFlow } from "@kanna/shared";
import { describe, expect, test, vi } from "vitest";
import { parseRawRequest, RequestLabService } from "./request-lab.js";

function fixture(fetcher: typeof fetch) {
  const db = openDatabase(":memory:");
  const projects = new ProjectsRepo(db);
  const sessions = new SessionsRepo(db);
  const bodies = new BodyStore(db);
  const flows = new FlowsRepo(db, bodies);
  const repo = new RequestLabRepo(db);
  const audit = new AuditRepo(db);
  const projectId = newId("prj");
  const sessionId = newId("sess");
  projects.save({
    id: projectId,
    name: "Lab",
    workspacePath: "C:/lab",
    createdAt: 1,
    updatedAt: 1,
  });
  sessions.create({
    id: sessionId,
    startedAt: 1,
    target: "http://target.test:8080",
    scope: {
      id: newId("sess"),
      name: "capture",
      allowedHosts: ["target.test"],
      allowedPorts: [8080],
      allowedProtocols: ["http"],
      maxRequestsPerSecond: 2,
      maxRequestsTotal: 10,
      activeTesting: false,
      createdAt: 1,
    },
  });
  const flow: TrafficFlow = {
    id: newId("flow"),
    sessionId,
    proxyFlowKey: "captured-1",
    timestampStart: 1,
    method: "POST",
    url: "http://target.test:8080/api/items?draft=1",
    host: "target.test",
    port: 8080,
    path: "/api/items?draft=1",
    requestHeaders: { "content-type": "application/json", cookie: "session=private" },
    requestBody: bodies.putRef(new TextEncoder().encode('{"token":"private","name":"one"}')),
    statusCode: 200,
    responseHeaders: { "content-type": "application/json" },
    source: "browser",
    timing: {},
    securityMetadata: {},
  };
  flows.save(flow);
  return {
    db,
    projectId,
    sessionId,
    flow,
    repo,
    audit,
    service: new RequestLabService(projects, sessions, flows, bodies, repo, audit, fetcher),
  };
}

describe("parseRawRequest", () => {
  test("parses an editable HTTP/1 request and rejects unsafe methods", () => {
    expect(parseRawRequest("POST /v1 HTTP/1.1\r\nContent-Type: text/plain\r\n\r\nhello")).toMatchObject({
      method: "POST",
      target: "/v1",
      body: "hello",
    });
    expect(() => parseRawRequest("CONNECT target.test:443 HTTP/1.1\r\n\r\n")).toThrow("not supported");
  });
});

describe("RequestLabService", () => {
  test("imports a captured request and replays an edited same-origin request", async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(_input)).toBe("http://target.test:8080/api/items/2?draft=0");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.body).toBe('{"name":"two"}');
      return new Response('{"ok":true}', {
        status: 201,
        headers: { "content-type": "application/json", "x-lab": "yes" },
      });
    }) as typeof fetch;
    const value = fixture(fetcher);
    try {
      const tab = value.service.importFlow(value.projectId, value.sessionId, value.flow.id);
      expect(tab.allowedOrigin).toBe("http://target.test:8080");
      expect(tab.rawRequest).toContain("POST /api/items?draft=1 HTTP/1.1");
      expect(tab.rawRequest).toContain('{"token":"private"');

      const raw =
        'POST /api/items/2?draft=0 HTTP/1.1\r\nContent-Type: application/json\r\nHost: other.invalid\r\n\r\n{"name":"two"}';
      const result = await value.service.send(tab.id, raw);
      expect(result.exchange.statusCode).toBe(201);
      expect(result.exchange.responseBody).toBe('{"ok":true}');
      expect(value.service.history(tab.id)).toHaveLength(1);
      expect(value.audit.count()).toBe(2);
    } finally {
      value.db.close();
    }
  });

  test("hard-blocks changing the origin and does not call fetch", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const value = fixture(fetcher);
    try {
      const tab = value.service.importFlow(value.projectId, value.sessionId, value.flow.id);
      await expect(value.service.send(tab.id, "GET http://other.test/ HTTP/1.1\r\n\r\n")).rejects.toThrow(
        "Out of scope",
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(value.service.history(tab.id)).toHaveLength(0);
    } finally {
      value.db.close();
    }
  });

  test("persists network errors and redacts evidence sent to the Agent", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const value = fixture(fetcher);
    try {
      const tab = value.service.importFlow(value.projectId, value.sessionId, value.flow.id);
      const result = await value.service.send(tab.id, tab.rawRequest);
      expect(result.exchange.error).toBe("connection refused");
      const prompt = value.service.analysisPrompt(tab.id, [result.exchange.id]);
      expect(prompt).toContain("[REDACTED]");
      expect(prompt).not.toContain("session=private");
      expect(prompt).not.toContain('"token":"private"');
    } finally {
      value.db.close();
    }
  });
});
