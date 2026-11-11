import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AuditEvent,
  BodyRef,
  BrowserAction,
  KannaEvent,
  TrafficFlow,
} from "@kanna/shared";
import { Correlator, newId } from "@kanna/shared";
import { FlowIngestor, pairsToRecord, type BodyStorage } from "./flow-ingestor.js";

const SESSION = "sess_test";
const T0 = 1_700_000_000_000;

function fakeBodies(): BodyStorage {
  return {
    putRef(bytes: Uint8Array, options?: { mimeType?: string; truncated?: boolean }): BodyRef {
      return {
        blobHash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        mimeType: options?.mimeType,
        truncated: options?.truncated ?? false,
      };
    },
  };
}

function makeFixture() {
  const flows = new Map<string, TrafficFlow>();
  const actions = new Map<string, BrowserAction>();
  const audits: AuditEvent[] = [];
  const events: KannaEvent[] = [];
  const correlator = new Correlator();
  const ingestor = new FlowIngestor({
    sessionId: SESSION,
    correlator,
    flows: { save: (f) => flows.set(f.id, f) },
    actions: {
      get: (id) => actions.get(id),
      save: (a) => actions.set(a.id, a),
    },
    audit: { append: (e) => audits.push(e) },
    bodies: fakeBodies(),
    emit: (e) => events.push(e),
  });
  return { ingestor, correlator, flows, actions, audits, events };
}

function actionInMap(id: string, seq: number): BrowserAction {
  return {
    id,
    sessionId: SESSION,
    seq,
    type: "navigate",
    params: {},
    pageId: "page_1",
    startedAt: T0,
    status: "running",
    correlatedFlowIds: [],
  };
}

describe("pairsToRecord", () => {
  it("joins duplicate headers", () => {
    expect(
      pairsToRecord([
        ["Set-Cookie", "a=1"],
        ["Set-Cookie", "b=2"],
        ["Content-Type", "text/html"],
      ]),
    ).toEqual({
      "Set-Cookie": "a=1, b=2",
      "Content-Type": "text/html",
    });
  });
});

describe("FlowIngestor", () => {
  it("full lifecycle: start → request → response with correlation and backfill", () => {
    const f = makeFixture();
    const action = actionInMap(newId("act"), 1);
    f.actions.set(action.id, action);
    f.correlator.actionStarted({
      actionId: action.id,
      pageId: "page_1",
      startedAt: T0,
    });

    const tsSec = T0 / 1000 + 0.05; // seconds (Python convention)
    f.ingestor.handle({
      v: 1,
      kind: "flow_start",
      flowKey: "mitm-1",
      timestampStart: tsSec,
      method: "POST",
      url: "http://localhost:3000/rest/user/login",
      host: "localhost",
      port: 3000,
      path: "/rest/user/login",
      clientPort: 51234,
    });
    f.ingestor.handle({
      v: 1,
      kind: "flow_request",
      flowKey: "mitm-1",
      headers: [
        ["Content-Type", "application/json"],
        ["Cookie", "session=abc"],
      ],
      body: { b64: Buffer.from('{"email":"x@y.z"}').toString("base64"), size: 16, truncated: false },
      timestampEnd: tsSec + 0.01,
    });
    f.ingestor.handle({
      v: 1,
      kind: "flow_response",
      flowKey: "mitm-1",
      statusCode: 200,
      headers: [["Content-Type", "application/json"]],
      body: { b64: Buffer.from('{"ok":true}').toString("base64"), size: 9, truncated: false },
      contentType: "application/json",
      timing: { ttfbMs: 12, totalMs: 30 },
      timestampEnd: tsSec + 0.05,
    });

    expect(f.flows.size).toBe(1);
    const flow = [...f.flows.values()][0] as TrafficFlow;
    expect(flow.timestampStart).toBeCloseTo(T0 + 50, -1); // seconds → ms conversion
    expect(flow.browserActionId).toBe(action.id);
    expect(flow.requestHeaders["Cookie"]).toBe("session=abc");
    expect(flow.requestBody?.size).toBe(17);
    expect(flow.statusCode).toBe(200);
    expect(flow.timing.ttfbMs).toBe(12);
    expect(flow.source).toBe("browser");

    // action backfill (burpwn fd-3 envelope pattern)
    expect(f.actions.get(action.id)?.correlatedFlowIds).toEqual([flow.id]);

    // UI events: flow + 2× flow_update
    const kinds = f.events.map((e) => e.type);
    expect(kinds).toEqual(["flow", "flow_update", "flow_update"]);

    const stats = f.ingestor.getStats();
    expect(stats.flowsStarted).toBe(1);
    expect(stats.flowsCompleted).toBe(1);
    expect(stats.attributedFlows).toBe(1);
    expect(stats.browserFlows).toBe(1);
  });

  it("sourceHint replay marks the flow source", () => {
    const f = makeFixture();
    f.ingestor.handle({
      v: 1,
      kind: "flow_start",
      flowKey: "mitm-r",
      timestampStart: T0 / 1000,
      method: "GET",
      url: "http://localhost:3000/x",
      host: "localhost",
      port: 3000,
      path: "/x",
      clientPort: 1,
      sourceHint: "replay",
    });
    const flow = [...f.flows.values()][0] as TrafficFlow;
    expect(flow.source).toBe("replay");
  });

  it("tracks pending and completed interception decisions on a flow", () => {
    const f = makeFixture();
    f.ingestor.handle({
      v: 1,
      kind: "flow_start",
      flowKey: "held-1",
      timestampStart: T0 / 1000,
      method: "GET",
      url: "http://localhost:3000/held",
      host: "localhost",
      port: 3000,
      path: "/held",
      clientPort: 1,
    });
    f.ingestor.handle({
      v: 1,
      kind: "intercept_pending",
      flowKey: "held-1",
      timestamp: T0 / 1000,
    });
    const flow = [...f.flows.values()][0] as TrafficFlow;
    expect(flow.securityMetadata.passiveFlags).toContain("intercept-pending");
    f.ingestor.handle({
      v: 1,
      kind: "intercept_decision",
      flowKey: "held-1",
      action: "drop",
      timestamp: T0 / 1000,
    });
    expect(flow.securityMetadata.passiveFlags).not.toContain("intercept-pending");
    expect(flow.securityMetadata.passiveFlags).toContain("intercept-dropped");
  });

  it("scope violations are audited and broadcast", () => {
    const f = makeFixture();
    f.ingestor.handle({
      v: 1,
      kind: "scope_violation",
      method: "GET",
      url: "http://evil.example.com/",
      host: "evil.example.com",
      reason: "host not in scope",
      timestamp: T0 / 1000,
    });
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]?.decision).toBe("blocked");
    expect(f.audits[0]?.eventType).toBe("scope_check");
    expect(f.events.some((e) => e.type === "audit")).toBe(true);
    expect(f.ingestor.getStats().scopeViolations).toBe(1);
  });

  it("unknown flowKey events are dropped without crashing", () => {
    const f = makeFixture();
    f.ingestor.handle({
      v: 1,
      kind: "flow_response",
      flowKey: "nope",
      statusCode: 200,
      headers: [],
      timestampEnd: T0 / 1000,
    });
    expect(f.flows.size).toBe(0);
    expect(f.events.some((e) => e.type === "log")).toBe(true);
  });

  it("addon_ready flips readiness", () => {
    const f = makeFixture();
    expect(f.ingestor.getStats().ready).toBe(false);
    f.ingestor.handle({ v: 1, kind: "addon_ready", addonVersion: "0.1.0" });
    expect(f.ingestor.getStats().ready).toBe(true);
  });
});
