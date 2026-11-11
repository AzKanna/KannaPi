import { BodyStore, FlowsRepo, openDatabase, SessionsRepo } from "@kanna/database";
import { newId, type TrafficFlow } from "@kanna/shared";
import { describe, expect, test } from "vitest";
import { PassiveReconService } from "./passive-recon.js";

function makeFlow(sessionId: string, bodies: BodyStore, over: Partial<TrafficFlow> = {}): TrafficFlow {
  return {
    id: newId("flow"),
    sessionId,
    proxyFlowKey: newId("flow"),
    timestampStart: Date.now(),
    method: "GET",
    url: "https://app.example.test/account/42?redirect=/home",
    host: "app.example.test",
    port: 443,
    path: "/account/42?redirect=/home",
    requestHeaders: { cookie: "session=private" },
    statusCode: 200,
    responseHeaders: {
      server: "nginx/1.24.0",
      "content-type": "text/html",
      "set-cookie": "sid=secret; Path=/",
      "cf-ray": "evidence",
    },
    responseBody: bodies.putRef(
      new TextEncoder().encode("<html><script>const api_key=private-secret-value</script></html>"),
      { mimeType: "text/html" },
    ),
    contentType: "text/html",
    source: "browser",
    timing: { totalMs: 30 },
    securityMetadata: {},
    ...over,
  };
}

describe("PassiveReconService", () => {
  test("builds a bounded deterministic report from captured traffic only", () => {
    const db = openDatabase(":memory:");
    try {
      const sessions = new SessionsRepo(db);
      const bodies = new BodyStore(db);
      const flows = new FlowsRepo(db, bodies);
      const sessionId = newId("sess");
      sessions.create({
        id: sessionId,
        startedAt: 1,
        target: "Authorized example",
        scope: {} as never,
      });
      const first = makeFlow(sessionId, bodies);
      const second = makeFlow(sessionId, bodies, {
        id: newId("flow"),
        proxyFlowKey: "flow-api",
        timestampStart: Date.now() + 1,
        method: "POST",
        url: "https://api.example.test/v1/profile",
        host: "api.example.test",
        path: "/v1/profile",
        requestHeaders: { authorization: "Bearer private-token" },
        responseHeaders: { "content-type": "application/json", "x-powered-by": "Express" },
        contentType: "application/json",
      });
      flows.save(first);
      flows.save(second);

      const service = new PassiveReconService(sessions, flows);
      const report = service.report(sessionId);
      expect(report.totalFlows).toBe(2);
      expect(report.hosts.map((host) => host.host)).toEqual(
        expect.arrayContaining(["app.example.test", "api.example.test"]),
      );
      expect(report.endpoints).toHaveLength(2);
      expect(report.parameters.some((parameter) => parameter.name === "redirect")).toBe(true);
      expect(report.technologies.map((item) => item.name)).toEqual(
        expect.arrayContaining(["nginx/1.24.0", "Express", "Cloudflare"]),
      );
      expect(report.signals.map((signal) => signal.moduleId)).toEqual(
        expect.arrayContaining(["security-headers", "cookie-flags", "secrets", "authenticated-cache"]),
      );
      expect(report.methods).toEqual(
        expect.arrayContaining([
          { name: "GET", count: 1 },
          { name: "POST", count: 1 },
        ]),
      );
    } finally {
      db.close();
    }
  });

  test("redacts sensitive values in optional Agent context", () => {
    const db = openDatabase(":memory:");
    try {
      const sessions = new SessionsRepo(db);
      const bodies = new BodyStore(db);
      const flows = new FlowsRepo(db, bodies);
      const sessionId = newId("sess");
      sessions.create({ id: sessionId, startedAt: 1, scope: {} as never });
      flows.save(makeFlow(sessionId, bodies));
      const prompt = new PassiveReconService(sessions, flows).analysisPrompt(sessionId);
      expect(prompt).toContain("<passive_recon_evidence>");
      expect(prompt).not.toContain("private-secret-value");
      expect(prompt).not.toContain("session=private");
    } finally {
      db.close();
    }
  });
});
