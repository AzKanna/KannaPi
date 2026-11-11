import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, Finding, TrafficFlow } from "@kanna/shared";
import { defaultLocalScope } from "@kanna/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApprovalManager,
  AuditLogger,
  analyzePassive,
  FindingService,
  PolicyEngine,
  RateLimiter,
  SecretRedactor,
  ToolGuard,
} from "./index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function makeFlow(): TrafficFlow {
  return {
    id: "flow_1",
    sessionId: "sess_1",
    proxyFlowKey: "p1",
    timestampStart: 1,
    method: "GET",
    url: "http://localhost:3000/api/users?id=1&redirect=http://evil.test",
    host: "localhost",
    port: 3000,
    path: "/api/users?id=1&redirect=http://evil.test",
    requestHeaders: {},
    statusCode: 200,
    responseHeaders: { server: "Express", "access-control-allow-origin": "*", "set-cookie": "sid=x; Path=/" },
    responseBody: {
      blobHash: "abc",
      size: 40,
      truncated: false,
      textPreview: "api_key=sk-secretvalue123456",
    },
    contentType: "application/json",
    source: "browser",
    timing: {},
    securityMetadata: {},
  };
}

describe("security layer", () => {
  test("redacts secrets recursively without mutating the source", () => {
    const source = {
      headers: { Authorization: "Bearer abc", Cookie: "sid=secret" },
      password: "hunter2",
      nested: ["token=abcd1234"],
    };
    const redacted = new SecretRedactor().redact(source) as typeof source;
    expect(redacted.headers.Authorization).toBe("[REDACTED]");
    expect(redacted.password).toBe("[REDACTED]");
    expect(redacted.nested[0]).toContain("[REDACTED]");
    expect(source.password).toBe("hunter2");
  });

  test("fails closed for unknown tools and blocks out-of-scope navigation before execution", async () => {
    const events: AuditEvent[] = [];
    const guard = new ToolGuard({
      scope: defaultLocalScope([3000]),
      policy: new PolicyEngine(),
      rateLimiter: new RateLimiter(10),
      approvals: new ApprovalManager(async () => "approved"),
      audit: new AuditLogger({ append: (e) => events.push(e) }),
    });
    const execute = vi.fn(async () => "ok");
    await expect(guard.invoke("made_up", {}, execute)).rejects.toThrow(/no policy/i);
    await expect(guard.invoke("browser_navigate", { url: "https://example.com" }, execute)).rejects.toThrow(
      /scope/i,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(events.some((e) => e.decision === "deny")).toBe(true);
  });

  test("requires active testing and per-call approval for tier 3 tools", async () => {
    const scope = { ...defaultLocalScope([3000]), activeTesting: true };
    const approval = vi.fn(async () => "approved" as const);
    const guard = new ToolGuard({
      scope,
      policy: new PolicyEngine(),
      rateLimiter: new RateLimiter(10),
      approvals: new ApprovalManager(approval),
      audit: new AuditLogger({ append: () => undefined }),
    });
    await expect(
      guard.invoke("traffic_replay", { url: "http://localhost:3000/api" }, async () => 7),
    ).resolves.toBe(7);
    expect(approval).toHaveBeenCalledOnce();
  });

  test("caches a tier 2 approval for the current session", async () => {
    const approval = vi.fn(async () => "approved" as const);
    const guard = new ToolGuard({
      scope: defaultLocalScope([3000]),
      policy: new PolicyEngine(),
      rateLimiter: new RateLimiter(10),
      approvals: new ApprovalManager(approval),
      audit: new AuditLogger({ append: () => undefined }),
    });
    await guard.invoke("traffic_search", { query: "token", in: "bodies" }, async () => []);
    await guard.invoke("traffic_search", { query: "secret", in: "bodies" }, async () => []);
    await guard.invoke("traffic_get", { flowId: "flow_1", includeBodies: true }, async () => ({}));
    await guard.invoke("traffic_get", { flowId: "flow_2", includeBodies: true }, async () => ({}));
    expect(approval).toHaveBeenCalledTimes(2);
  });

  test("writes append-only audit JSONL and repository records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-audit-"));
    tempDirs.push(dir);
    const records: AuditEvent[] = [];
    const logger = new AuditLogger({ append: (e) => records.push(e) }, join(dir, "audit.jsonl"));
    await logger.log({ actor: "tool", eventType: "tool_call", decision: "allow", toolName: "traffic_list" });
    expect(records).toHaveLength(1);
    expect(JSON.parse((await readFile(join(dir, "audit.jsonl"), "utf8")).trim()).toolName).toBe(
      "traffic_list",
    );
  });

  test("passive analysis emits deterministic evidence-linked observations", () => {
    const observations = analyzePassive([makeFlow()]);
    expect(observations.every((o) => o.flowId === "flow_1")).toBe(true);
    expect(observations.map((o) => o.moduleId)).toEqual(
      expect.arrayContaining([
        "security-headers",
        "cookie-flags",
        "cors",
        "server-fingerprint",
        "secrets",
        "suspicious-parameters",
      ]),
    );
  });

  test("finding service enforces evidence and deduplicates by category/endpoint/parameter", () => {
    const saved: Finding[] = [];
    const service = new FindingService({ save: (_session, f) => saved.push(f) });
    const base = {
      title: "Weak cookie",
      category: "cookie-flags" as const,
      severity: "medium" as const,
      confidence: "high" as const,
      endpoint: { method: "GET", pathTemplate: "/api/users" },
      parameter: "sid",
      description: "Cookie lacks Secure",
      evidence: { flowIds: ["flow_1"] },
      requestIds: ["flow_1"],
      reproduction: "Inspect response",
      remediation: "Set Secure",
      status: "confirmed" as const,
    };
    expect(() => service.report("sess_1", { ...base, evidence: { flowIds: [] }, requestIds: [] })).toThrow(
      /evidence/i,
    );
    const first = service.report("sess_1", base);
    const second = service.report("sess_1", { ...base, title: "Updated title" });
    expect(second.id).toBe(first.id);
    expect(saved).toHaveLength(2);
  });
});
