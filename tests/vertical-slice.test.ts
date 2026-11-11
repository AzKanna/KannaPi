import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession, EvidenceStore } from "@kanna/browser";
import {
  ActionsRepo,
  AuditRepo,
  BodyStore,
  FindingsRepo,
  FlowsRepo,
  openDatabase,
  SessionsRepo,
} from "@kanna/database";
import {
  ApprovalManager,
  AuditLogger,
  analyzePassive,
  FindingService,
  PolicyEngine,
  RateLimiter,
  ToolGuard,
} from "@kanna/security";
import { Correlator, defaultLocalScope, type KannaEvent, type ProxyEvent } from "@kanna/shared";
import { FlowIngestor, FlowStore, IngestServer } from "@kanna/traffic";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { UiEventBus } from "../apps/server/src/main.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Phase 1 vertical slice", () => {
  test("meets the seven deterministic acceptance gates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-vertical-"));
    dirs.push(dir);
    let apiHits = 0;
    let target: Server;
    target = createServer((request, response) => {
      if (request.url === "/api/search?q=kanna") {
        apiHits++;
        response.setHeader("content-type", "application/json");
        response.end('{"results":[]}');
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><title>${request.url}</title><a href="/two">Two</a><button id="search">Search</button><script>document.querySelector('#search').onclick=()=>fetch('/api/search?q=kanna')</script>`,
      );
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("target did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const dbPath = join(dir, "kanna.db");
    const db = openDatabase(dbPath);
    const sessionId = "sess_vertical";
    const scope = defaultLocalScope([address.port]);
    const sessions = new SessionsRepo(db);
    sessions.create({ id: sessionId, startedAt: Date.now(), target: baseUrl, scope });
    const bodies = new BodyStore(db);
    const flowsRepo = new FlowsRepo(db, bodies);
    const actions = new ActionsRepo(db);
    const auditRepo = new AuditRepo(db);
    const findingsRepo = new FindingsRepo(db);
    const correlator = new Correlator();
    const events: KannaEvent[] = [];
    let bus: UiEventBus | undefined;
    const emit = (event: KannaEvent) => {
      events.push(event);
      bus?.broadcast(event);
    };
    const ingestor = new FlowIngestor({
      sessionId,
      correlator,
      flows: flowsRepo,
      actions,
      audit: auditRepo,
      bodies,
      emit,
    });
    const ingest = new IngestServer({ port: 0, onProxyEvent: (event) => ingestor.handle(event) });
    bus = new UiEventBus(ingest);
    await ingest.start();
    const liveEvents: KannaEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${ingest.port}/ui`);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", resolve);
      socket.on("error", reject);
    });
    socket.on("message", (data) => liveEvents.push(JSON.parse(String(data)) as KannaEvent));

    const browser = await BrowserSession.launch({
      sessionId,
      actions,
      correlator,
      evidenceStore: new EvidenceStore(join(dir, "evidence")),
      emit,
      settleQuietPeriodMs: 0,
      zeroFlowCheckDelayMs: 5,
    });
    try {
      await browser.navigate(`${baseUrl}/`);
      await browser.navigate(`${baseUrl}/two`);
      await browser.navigate(`${baseUrl}/three`);
      await browser.click("#search");
      await wait(30);
      expect(actions.listBySession(sessionId).filter((action) => action.type === "navigate")).toHaveLength(3);
      expect(apiHits).toBe(1);

      const browserActions = actions.listBySession(sessionId);
      for (let i = 0; i < 10; i++) {
        const action = i < 9 ? browserActions[i % browserActions.length] : undefined;
        const timestampMs = action ? action.startedAt : Date.now() - 30_000;
        const url = `${baseUrl}/captured/${i}`;
        if (action)
          correlator.recordPageEvent({ method: "GET", url, wallTime: timestampMs, actionId: action.id });
        const parts: ProxyEvent[] = [
          {
            v: 1,
            kind: "flow_start",
            flowKey: `proxy_${i}`,
            timestampStart: timestampMs / 1000,
            method: "GET",
            url,
            host: "127.0.0.1",
            port: address.port,
            path: `/captured/${i}`,
            clientPort: 1,
          },
          {
            v: 1,
            kind: "flow_request",
            flowKey: `proxy_${i}`,
            headers: [],
            timestampEnd: timestampMs / 1000,
          },
          {
            v: 1,
            kind: "flow_response",
            flowKey: `proxy_${i}`,
            statusCode: 200,
            headers: [
              ["content-type", "text/html"],
              ["server", "test-server"],
            ],
            timestampEnd: (timestampMs + 1) / 1000,
            contentType: "text/html",
          },
        ];
        for (const part of parts) ingestor.handle(part);
      }
      const stats = ingestor.getStats();
      expect(stats.attributedFlows / stats.browserFlows).toBeGreaterThanOrEqual(0.9);
      const firstAction = browserActions[0];
      if (!firstAction) throw new Error("expected browser actions");
      const firstActionFlows = new FlowStore(flowsRepo).listByAction(firstAction.id);
      expect(firstActionFlows.length).toBeGreaterThan(0);

      const observations = analyzePassive(flowsRepo.recent(sessionId, 0, 100));
      const evidence = observations[0];
      expect(evidence).toBeDefined();
      if (!evidence) throw new Error("expected passive evidence");
      const finding = new FindingService(findingsRepo).report(sessionId, {
        title: evidence.title,
        category: evidence.category,
        severity: evidence.severityHint,
        confidence: "high",
        description: evidence.detail,
        evidence: { flowIds: [evidence.flowId] },
        requestIds: [evidence.flowId],
        reproduction: "Inspect captured response",
        remediation: "Apply the missing defense",
        status: "confirmed",
      });
      emit({ type: "finding", finding });
      expect(findingsRepo.list(sessionId)[0]?.requestIds).toContain(evidence.flowId);

      const execute = vi.fn(async () => undefined);
      const guard = new ToolGuard({
        scope,
        policy: new PolicyEngine(),
        rateLimiter: new RateLimiter(10),
        approvals: new ApprovalManager(async () => "denied"),
        audit: new AuditLogger(auditRepo),
      });
      await expect(guard.invoke("browser_navigate", { url: "https://example.com" }, execute)).rejects.toThrow(
        /scope/i,
      );
      ingestor.handle({
        v: 1,
        kind: "scope_violation",
        method: "GET",
        url: "https://example.com",
        host: "example.com",
        reason: "not allowlisted",
        timestamp: Date.now() / 1000,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(
        auditRepo
          .list({ limit: 100, offset: 0 })
          .filter((event) => event.eventType === "scope_check" || event.decision === "deny").length,
      ).toBeGreaterThanOrEqual(2);

      await wait(30);
      expect(liveEvents.some((event) => event.type === "action")).toBe(true);
      expect(liveEvents.some((event) => event.type === "flow")).toBe(true);
      expect(liveEvents.some((event) => event.type === "finding")).toBe(true);
    } finally {
      await browser.close();
      socket.close();
      await bus.close();
      await ingest.stop();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      db.close();
    }

    const reopened = openDatabase(dbPath);
    try {
      expect(new SessionsRepo(reopened).get(sessionId)?.target).toBe(baseUrl);
      expect(new FlowsRepo(reopened, new BodyStore(reopened)).countBySession(sessionId)).toBe(10);
      expect(new FindingsRepo(reopened).list(sessionId)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  }, 30_000);
});
