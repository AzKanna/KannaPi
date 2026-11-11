import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserAction, Endpoint, Finding, TrafficFlow } from "@kanna/shared";
import { newId } from "@kanna/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActionsRepo,
  AgentChatSessionsRepo,
  AgentWorkspacesRepo,
  AttackGraphsRepo,
  AuditRepo,
  BodyStore,
  EndpointsRepo,
  FindingsRepo,
  FlowsRepo,
  HypothesesRepo,
  openDatabase,
  ProjectAssetsRepo,
  ProjectsRepo,
  SessionsRepo,
  TestsRepo,
} from "./index.js";

interface TestDb {
  sessionId: string;
  bodies: BodyStore;
  sessions: SessionsRepo;
  flows: FlowsRepo;
  actions: ActionsRepo;
  endpoints: EndpointsRepo;
  findings: FindingsRepo;
  hypotheses: HypothesesRepo;
  tests: TestsRepo;
  audit: AuditRepo;
  close(): void;
}

function makeDb(): TestDb {
  const db = openDatabase(":memory:");
  const sessionId = newId("sess");
  const sessions = new SessionsRepo(db);
  sessions.create({
    id: sessionId,
    startedAt: Date.now(),
    target: "http://localhost:3000",
    scope: {} as never,
  });
  return {
    sessionId,
    bodies: new BodyStore(db),
    sessions,
    flows: new FlowsRepo(db, new BodyStore(db)),
    actions: new ActionsRepo(db),
    endpoints: new EndpointsRepo(db),
    findings: new FindingsRepo(db),
    hypotheses: new HypothesesRepo(db),
    tests: new TestsRepo(db),
    audit: new AuditRepo(db),
    close: () => db.close(),
  };
}

function makeFlow(sessionId: string, over: Partial<TrafficFlow> = {}): TrafficFlow {
  return {
    id: newId("flow"),
    sessionId,
    proxyFlowKey: `mitm-${Math.random().toString(36).slice(2, 10)}`,
    timestampStart: Date.now(),
    method: "GET",
    url: "http://localhost:3000/rest/products",
    host: "localhost",
    port: 3000,
    path: "/rest/products",
    requestHeaders: { host: "localhost:3000" },
    statusCode: 200,
    responseHeaders: { "content-type": "application/json" },
    contentType: "application/json",
    source: "browser",
    timing: { totalMs: 42 },
    securityMetadata: {},
    ...over,
  };
}

let t: TestDb;
beforeEach(() => {
  t = makeDb();
});
afterEach(() => {
  t.close();
});

describe("openDatabase", () => {
  it("runs migrations idempotently on a file db", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanna-db-"));
    const path = join(dir, "test.db");
    const db1 = openDatabase(path);
    db1.close();
    const db2 = openDatabase(path);
    const row = db2.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBeGreaterThan(0);
    db2.close();
  });
});

describe("BodyStore", () => {
  it("deduplicates identical bytes by sha256", () => {
    const bytes = new TextEncoder().encode('{"data":"hello"}');
    const a = t.bodies.put(bytes);
    const b = t.bodies.put(bytes);
    expect(a.hash).toBe(b.hash);
    expect(t.bodies.get(a.hash)).toEqual(bytes);
    expect(t.bodies.has(a.hash)).toBe(true);
    expect(t.bodies.has("deadbeef")).toBe(false);
  });

  it("builds BodyRef with text preview", () => {
    const bytes = new TextEncoder().encode("<html>body</html>");
    const ref = t.bodies.putRef(bytes, { mimeType: "text/html" });
    expect(ref.mimeType).toBe("text/html");
    expect(ref.size).toBe(bytes.byteLength);
    expect(ref.textPreview).toContain("<html>");
  });
});

describe("FlowsRepo", () => {
  it("saves and round-trips a complete flow", () => {
    const reqBytes = new TextEncoder().encode('{"q":"apple"}');
    const resBytes = new TextEncoder().encode('{"total":3}');
    const flow = makeFlow(t.sessionId, {
      method: "POST",
      requestBody: t.bodies.putRef(reqBytes, { mimeType: "application/json" }),
      responseBody: t.bodies.putRef(resBytes, { mimeType: "application/json" }),
    });
    t.flows.save(flow);

    const loaded = t.flows.get(flow.id);
    expect(loaded).toBeDefined();
    expect(loaded?.method).toBe("POST");
    expect(loaded?.requestBody?.blobHash).toBe(flow.requestBody?.blobHash);
    expect(loaded?.responseBody?.size).toBe(resBytes.byteLength);
    expect(loaded?.timing.totalMs).toBe(42);

    if (!flow.responseBody) throw new Error("response body fixture missing");
    const raw = t.flows.getBodyBytes(flow.responseBody.blobHash);
    if (!raw) throw new Error("stored response body missing");
    expect(new TextDecoder().decode(raw)).toBe('{"total":3}');
  });

  it("supports progressive upsert (start → request → response)", () => {
    const flow = makeFlow(t.sessionId, { statusCode: undefined, responseHeaders: {} });
    t.flows.save(flow);
    expect(t.flows.get(flow.id)?.statusCode).toBeUndefined();

    const updated = { ...flow, statusCode: 500, responseHeaders: { "content-type": "text/html" } };
    t.flows.save(updated);
    expect(t.flows.get(flow.id)?.statusCode).toBe(500);
  });

  it("lists with filters and pagination", () => {
    const actionId = newId("act");
    t.flows.save(makeFlow(t.sessionId, { method: "GET", statusCode: 200, browserActionId: actionId }));
    t.flows.save(makeFlow(t.sessionId, { method: "POST", statusCode: 401, path: "/rest/user/login" }));
    t.flows.save(makeFlow(t.sessionId, { method: "GET", statusCode: 200, path: "/rest/products/1" }));

    const all = t.flows.list(t.sessionId, { limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.rows).toHaveLength(3);

    const gets = t.flows.list(t.sessionId, { method: "GET", limit: 10, offset: 0 });
    expect(gets.total).toBe(2);

    const byAction = t.flows.list(t.sessionId, { actionId, limit: 10, offset: 0 });
    expect(byAction.total).toBe(1);
    expect(byAction.rows[0]?.browserActionId).toBe(actionId);

    const page = t.flows.list(t.sessionId, { limit: 2, offset: 1 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);

    const pathPrefix = t.flows.list(t.sessionId, { pathPrefix: "/rest/products", limit: 10, offset: 0 });
    expect(pathPrefix.total).toBe(2);
  });

  it("round-trips by proxy flow key", () => {
    const flow = makeFlow(t.sessionId, { proxyFlowKey: "mitm-fixed-key" });
    t.flows.save(flow);
    expect(t.flows.getByProxyKey(t.sessionId, "mitm-fixed-key")?.id).toBe(flow.id);
  });

  it("lists flows by action", () => {
    const actionId = newId("act");
    t.flows.save(makeFlow(t.sessionId, { browserActionId: actionId }));
    t.flows.save(makeFlow(t.sessionId, { browserActionId: actionId }));
    t.flows.save(makeFlow(t.sessionId));
    expect(t.flows.listByAction(actionId)).toHaveLength(2);
  });
});

describe("ActionsRepo", () => {
  it("saves, updates correlated flows, lists by session", () => {
    const action: BrowserAction = {
      id: newId("act"),
      sessionId: t.sessionId,
      seq: 1,
      type: "navigate",
      params: { url: "http://localhost:3000/" },
      pageId: "page-1",
      startedAt: Date.now(),
      status: "running",
      correlatedFlowIds: [],
    };
    t.actions.save(action);
    expect(t.actions.get(action.id)?.status).toBe("running");

    t.actions.setCorrelatedFlowIds(action.id, [newId("flow"), newId("flow")]);
    expect(t.actions.get(action.id)?.correlatedFlowIds).toHaveLength(2);

    const action2 = { ...action, id: newId("act"), seq: 2, type: "click" };
    t.actions.save(action2);
    const list = t.actions.listBySession(t.sessionId);
    expect(list).toHaveLength(2);
    expect(list[0]?.seq).toBe(1);
  });
});

describe("EndpointsRepo", () => {
  const endpoint: Endpoint = {
    id: newId("ep"),
    host: "localhost",
    method: "GET",
    pathTemplate: "/rest/products/:id",
    parameters: [{ name: "id", locations: ["path"] }],
    contentTypes: ["application/json"],
    authRequired: "unknown",
    observedStatusCodes: [200],
    observedFromFlowIds: [],
    firstSeen: 1000,
    lastSeen: 1000,
    testState: "untested",
  };

  it("upserts on identity (host, method, pathTemplate)", () => {
    t.endpoints.save(t.sessionId, endpoint);
    t.endpoints.save(t.sessionId, { ...endpoint, lastSeen: 2000, observedStatusCodes: [200, 404] });

    const all = t.endpoints.list(t.sessionId);
    expect(all).toHaveLength(1);
    expect(all[0]?.lastSeen).toBe(2000);

    const found = t.endpoints.findByIdentity(t.sessionId, "localhost", "GET", "/rest/products/:id");
    expect(found?.observedStatusCodes).toEqual([200, 404]);
  });
});

describe("security repos", () => {
  it("round-trips findings, hypotheses, tests", () => {
    const finding: Finding = {
      id: newId("fnd"),
      title: "Missing Content-Security-Policy",
      category: "security-headers",
      severity: "low",
      confidence: "high",
      description: "No CSP header on main document responses",
      evidence: { flowIds: [newId("flow")] },
      requestIds: [],
      reproduction: "GET / and inspect response headers",
      remediation: "Add a Content-Security-Policy header",
      status: "confirmed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    t.findings.save(t.sessionId, finding);
    expect(t.findings.get(finding.id)?.status).toBe("confirmed");
    expect(t.findings.list(t.sessionId, { category: "security-headers" })).toHaveLength(1);
    expect(t.findings.list(t.sessionId, { category: "cors" })).toHaveLength(0);

    const hyp = {
      id: newId("hyp"),
      category: "idor",
      title: "userId may be object-level auth",
      rationale: "POST /api/user/update accepts userId in body",
      basedOnFlowIds: [],
      basedOnActionIds: [],
      confidence: 0.6,
      priority: "high",
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as const;
    t.hypotheses.save(t.sessionId, hyp);
    expect(t.hypotheses.list(t.sessionId, "open")).toHaveLength(1);

    const test = {
      id: newId("tst"),
      hypothesisId: hyp.id,
      strategy: "idor-swap-object-id",
      plannedRequests: [],
      policy: {},
    };
    t.tests.save(t.sessionId, test);
    expect(t.tests.listByHypothesis(hyp.id)).toHaveLength(1);
  });
});

describe("AuditRepo", () => {
  it("appends and filters audit events", () => {
    t.audit.append({
      id: newId("aud"),
      timestamp: 1000,
      actor: "tool",
      eventType: "scope_check",
      decision: "deny",
      reason: "host not in allowedHosts",
    });
    t.audit.append({
      id: newId("aud"),
      timestamp: 2000,
      actor: "tool",
      eventType: "tool_call",
      toolName: "browser_navigate",
      decision: "allow",
    });
    expect(t.audit.count()).toBe(2);
    const denies = t.audit.list({ decision: "deny", limit: 10, offset: 0 });
    expect(denies).toHaveLength(1);
    expect(denies[0]?.reason).toContain("allowedHosts");
    const since = t.audit.list({ sinceTs: 1500, limit: 10, offset: 0 });
    expect(since).toHaveLength(1);
    expect(since[0]?.toolName).toBe("browser_navigate");
  });
});

describe("SessionsRepo", () => {
  it("creates, ends and lists sessions", () => {
    const id = newId("sess");
    t.sessions.create({ id, startedAt: 123, target: "http://x", scope: {} as never });
    t.sessions.end(id, 456);
    const got = t.sessions.get(id);
    expect(got?.endedAt).toBe(456);
    expect(t.sessions.list().length).toBeGreaterThanOrEqual(2);
  });
});

describe("general Agent workspace repos", () => {
  it("persists projects, assets and Agent session metadata", () => {
    const db = openDatabase(":memory:");
    const projects = new ProjectsRepo(db);
    const assets = new ProjectAssetsRepo(db);
    const agents = new AgentWorkspacesRepo(db);
    const project = {
      id: newId("prj"),
      name: "General work",
      workspacePath: "C:/workspace",
      createdAt: 1,
      updatedAt: 1,
    };
    projects.save(project);
    assets.save({
      id: newId("asset"),
      projectId: project.id,
      type: "text",
      name: "Brief",
      value: "Build a report",
      metadata: {},
      createdAt: 2,
    });
    agents.save({
      id: newId("agent"),
      projectId: project.id,
      name: "Writer",
      providerId: "fake",
      modelId: "model",
      thinkingLevel: "high",
      cwd: project.workspacePath,
      systemPrompt: "Help",
      toolProfile: "read-only",
      status: "idle",
      createdAt: 3,
      updatedAt: 3,
    });
    expect(projects.list()).toHaveLength(1);
    expect(assets.list(project.id)[0]?.name).toBe("Brief");
    expect(agents.list(project.id)[0]).toMatchObject({ toolProfile: "read-only", thinkingLevel: "high" });
    db.close();
  });

  it("persists independent chat sessions and cascades them with the Agent", () => {
    const db = openDatabase(":memory:");
    const projects = new ProjectsRepo(db);
    const agents = new AgentWorkspacesRepo(db);
    const sessions = new AgentChatSessionsRepo(db);
    projects.save({ id: "prj_sessions", name: "Sessions", workspacePath: "C:/one", createdAt: 1, updatedAt: 1 });
    agents.save({
      id: "agent_sessions",
      projectId: "prj_sessions",
      name: "Agent",
      providerId: "fake",
      modelId: "model",
      thinkingLevel: "medium",
      cwd: "C:/one",
      systemPrompt: "Help",
      toolProfile: "read-only",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    sessions.save({ id: "chat_one", agentId: "agent_sessions", name: "One", workspacePath: "C:/one", createdAt: 2, updatedAt: 2 });
    sessions.save({ id: "chat_two", agentId: "agent_sessions", name: "Two", workspacePath: "C:/two", createdAt: 3, updatedAt: 3 });
    expect(sessions.list("agent_sessions").map((session) => session.name)).toEqual(["Two", "One"]);
    expect(sessions.get("agent_sessions", "chat_one")?.workspacePath).toBe("C:/one");
    db.prepare("DELETE FROM agent_workspaces WHERE id = ?").run("agent_sessions");
    expect(sessions.list("agent_sessions")).toEqual([]);
    db.close();
  });

  it("persists graphs by session while retaining the latest Agent graph", () => {
    const db = openDatabase(":memory:");
    const projects = new ProjectsRepo(db);
    const agents = new AgentWorkspacesRepo(db);
    const graphs = new AttackGraphsRepo(db);
    projects.save({
      id: "prj_graph",
      name: "Graph",
      workspacePath: "C:/workspace",
      createdAt: 1,
      updatedAt: 1,
    });
    agents.save({
      id: "agent_graph",
      projectId: "prj_graph",
      name: "Graph Agent",
      providerId: "fake",
      modelId: "model",
      thinkingLevel: "medium",
      cwd: "C:/workspace",
      systemPrompt: "Help",
      toolProfile: "read-only",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    graphs.save({
      agentId: "agent_graph",
      sessionId: "chat_one",
      runId: "run_1",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      nodes: [{ id: "node_1", kind: "objective", title: "Objective", status: "completed", timestamp: 1 }],
      edges: [],
    });
    graphs.save({ agentId: "agent_graph", sessionId: "chat_two", runId: "run_2",
      status: "completed", startedAt: 3, completedAt: 4, nodes: [], edges: [] });
    expect(graphs.get("agent_graph")).toMatchObject({ runId: "run_2", status: "completed" });
    expect(graphs.getBySession("agent_graph", "chat_one")).toMatchObject({ runId: "run_1" });
    expect(graphs.getBySession("agent_graph", "chat_two")).toMatchObject({ runId: "run_2" });
    graphs.deleteBySession("agent_graph", "chat_one");
    expect(graphs.getBySession("agent_graph", "chat_one")).toBeUndefined();
    graphs.deleteBySession("agent_graph", "chat_two");
    expect(graphs.get("agent_graph")).toBeUndefined();
    db.close();
  });
});
