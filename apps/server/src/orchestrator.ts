import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createKannaAgentSession, createKannaTools } from "@kanna/agent";
import { BrowserSession, EvidenceStore } from "@kanna/browser";
import {
  ActionsRepo,
  AuditRepo,
  BodyStore,
  EndpointsRepo,
  FindingsRepo,
  FlowsRepo,
  openDatabase,
  SessionsRepo,
} from "@kanna/database";
import {
  ApprovalManager,
  AuditLogger,
  cliApprovalBackend,
  FindingService,
  PolicyEngine,
  RateLimiter,
  ToolGuard,
} from "@kanna/security";
import { Correlator, type KannaEvent, newId, parseScopeFile, type Scope } from "@kanna/shared";
import { AppStateBuilder } from "@kanna/state";
import {
  FlowIngestor,
  FlowStore,
  IngestServer,
  ProxySupervisor,
  resolveAddonPath,
  resolveMitmdumpPath,
} from "@kanna/traffic";
import { RestApi, UiEventBus } from "./backend.js";
import { type RunLimitConfig, RunLimits } from "./run-limits.js";

export interface ScanOptions {
  target: string;
  scope?: Scope;
  scopePath?: string;
  repoRoot?: string;
  dataDir?: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  modelsPath: string;
  authPath?: string;
  prompt?: string;
  proxyPort?: number;
  serverPort?: number;
  resume?: boolean;
  limits?: Partial<RunLimitConfig>;
  onEvent?: (event: KannaEvent) => void;
}
export interface ScanSummary {
  sessionId: string;
  flows: number;
  actions: number;
  findings: number;
  attributionRate: number;
}

function scopeSpec(scope: Scope): string {
  return scope.allowedHosts.flatMap((host) => scope.allowedPorts.map((port) => `${host}:${port}`)).join(",");
}

export async function runScan(options: ScanOptions): Promise<ScanSummary> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const dataDir = resolve(options.dataDir ?? join(repoRoot, "data"));
  await mkdir(join(dataDir, "evidence"), { recursive: true });
  if (!options.scope && !options.scopePath) throw new Error("scope or scopePath is required");
  const scope = options.scope ?? parseScopeFile(await readFile(options.scopePath as string, "utf8"));
  const sessionId = newId("sess");
  const db = openDatabase(join(dataDir, "kanna.db"));
  const sessions = new SessionsRepo(db);
  const bodies = new BodyStore(db);
  const flowsRepo = new FlowsRepo(db, bodies);
  const actions = new ActionsRepo(db);
  const findingsRepo = new FindingsRepo(db);
  const auditRepo = new AuditRepo(db);
  const endpoints = new EndpointsRepo(db);
  const flowStore = new FlowStore(flowsRepo);
  sessions.create({ id: sessionId, startedAt: Date.now(), target: options.target, scope });
  const correlator = new Correlator();
  const state = new AppStateBuilder(sessionId, endpoints);
  let bus: UiEventBus | undefined;
  let proxy: ProxySupervisor | undefined;
  let browser: BrowserSession | undefined;
  let agent: Awaited<ReturnType<typeof createKannaAgentSession>> | undefined;
  const limits = new RunLimits({
    maxTurns: options.limits?.maxTurns ?? 40,
    maxTokens: options.limits?.maxTokens ?? 200_000,
    maxCostUsd: options.limits?.maxCostUsd ?? 5,
    maxDurationMs: options.limits?.maxDurationMs ?? 30 * 60_000,
  });
  let limitViolation: string | undefined;
  const emit = (event: KannaEvent): void => {
    bus?.broadcast(event);
    options.onEvent?.(event);
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
  let summary: ScanSummary | undefined;
  const ingest = new IngestServer({
    port: options.serverPort ?? 8081,
    onProxyEvent: (event) => {
      ingestor.handle(event);
      if (event.kind === "addon_ready") proxy?.markReady();
      if (event.kind === "flow_response") {
        const flow = flowsRepo.getByProxyKey(sessionId, event.flowKey);
        if (flow) state.consume(flow);
      }
    },
    onInvalidMessage: (detail) =>
      emit({ type: "log", level: "warn", message: "Invalid proxy message", detail }),
  });
  bus = new UiEventBus(ingest);
  new RestApi(ingest, { sessions, actions, flows: flowsRepo, findings: findingsRepo });
  try {
    emit({ type: "run", status: "starting", sessionId });
    await ingest.start();
    proxy = new ProxySupervisor({
      mitmdumpPath: resolveMitmdumpPath(repoRoot),
      addonPath: resolveAddonPath(),
      ingestUrl: ingest.ingestUrl,
      scopeSpec: scopeSpec(scope),
      listenPort: options.proxyPort ?? 8080,
      onLog: (message) => emit({ type: "log", level: "info", message }),
      onExit: (code) =>
        emit({
          type: "log",
          level: code === 0 ? "info" : "error",
          message: `mitmdump exited (${code ?? "signal"})`,
        }),
    });
    await proxy.start();
    await proxy.waitForReady();
    browser = await BrowserSession.launch({
      sessionId,
      actions,
      correlator,
      evidenceStore: new EvidenceStore(join(dataDir, "evidence")),
      proxyServer: `http://127.0.0.1:${options.proxyPort ?? 8080}`,
      emit,
    });
    const guard = new ToolGuard({
      scope,
      policy: new PolicyEngine(),
      rateLimiter: new RateLimiter(scope.maxRequestsPerSecond, scope.maxRequestsTotal),
      approvals: new ApprovalManager(cliApprovalBackend),
      audit: new AuditLogger(auditRepo, join(dataDir, "audit.jsonl")),
    });
    const tools = createKannaTools({
      sessionId,
      guard,
      browser,
      flows: flowStore,
      state,
      findings: new FindingService(findingsRepo),
      searchTraffic: (query, field, limit) =>
        flowStore
          .recent(sessionId, 3600)
          .filter((flow) => {
            const haystack =
              field === "url"
                ? flow.url
                : field === "headers"
                  ? JSON.stringify([flow.requestHeaders, flow.responseHeaders])
                  : `${flow.requestBody?.textPreview ?? ""}\n${flow.responseBody?.textPreview ?? ""}`;
            return haystack.toLowerCase().includes(query.toLowerCase());
          })
          .slice(0, limit),
    });
    agent = await createKannaAgentSession({
      cwd: repoRoot,
      agentDir: dataDir,
      modelsPath: resolve(options.modelsPath),
      authPath: resolve(options.authPath ?? join(dataDir, "auth.json")),
      providerId: options.providerId,
      modelId: options.modelId,
      apiKey: options.apiKey,
      tools,
      sessionDir: join(dataDir, "sessions"),
      resume: options.resume,
      emit: (event) => {
        emit(event);
        if (event.type === "agent" && !limitViolation) {
          limitViolation = limits.observe(event.event);
          if (limitViolation) {
            emit({ type: "log", level: "warn", message: limitViolation });
            void agent?.session.abort();
          }
        }
      },
    });
    emit({ type: "run", status: "running", sessionId });
    await agent.session.prompt(
      options.prompt ??
        `Autonomously inspect ${options.target} within the configured authorization scope. Visit at least three relevant pages, perform one safe SPA interaction, analyze captured traffic passively, and report evidence-linked findings.`,
    );
    await agent.waitUntilIdle();
    emit({ type: "run", status: "idle", sessionId });
  } finally {
    agent?.dispose();
    await browser?.close().catch(() => undefined);
    await proxy?.stop().catch(() => undefined);
    await bus?.close().catch(() => undefined);
    await ingest.stop().catch(() => undefined);
    sessions.end(sessionId);
    const stats = ingestor.getStats();
    summary = {
      sessionId,
      flows: flowsRepo.countBySession(sessionId),
      actions: actions.listBySession(sessionId).length,
      findings: findingsRepo.list(sessionId).length,
      attributionRate: stats.browserFlows === 0 ? 0 : stats.attributedFlows / stats.browserFlows,
    };
    db.close();
    options.onEvent?.({ type: "run", status: "ended", sessionId });
  }
  return summary as ScanSummary;
}
