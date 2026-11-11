/**
 * FlowIngestor — consumes validated ProxyEvents from the addon, maintains the
 * in-flight flow aggregate, correlates with browser actions, persists, and
 * emits KannaEvents for the UI bus.
 *
 * Persistence goes through narrow structural interfaces (implemented by
 * @kanna/database repos) so this package stays decoupled from the database.
 */
import {
  type AuditEvent,
  type BodyRef,
  type BrowserAction,
  type FlowSource,
  type HeaderPairs,
  type KannaEvent,
  type ProxyEvent,
  type TrafficFlow,
  newId,
  toFlowSummary,
  type Correlator,
} from "@kanna/shared";

export interface FlowPersister {
  save(flow: TrafficFlow): void;
}

export interface ActionPersister {
  get(id: string): BrowserAction | undefined;
  save(action: BrowserAction): void;
}

export interface AuditSink {
  append(event: AuditEvent): void;
}

export interface BodyStorage {
  putRef(bytes: Uint8Array, options?: { mimeType?: string; truncated?: boolean }): BodyRef;
}

export interface FlowIngestorOptions {
  sessionId: string;
  correlator: Correlator;
  flows: FlowPersister;
  actions: ActionPersister;
  audit: AuditSink;
  bodies: BodyStorage;
  /** KannaEvent sink (UI bus). */
  emit(event: KannaEvent): void;
}

/** Header pairs (order/duplicate preserving) → Record (duplicates joined ", "). */
export function pairsToRecord(pairs: HeaderPairs): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of pairs) {
    record[name] = name in record ? `${record[name]}, ${value}` : value;
  }
  return record;
}

export interface IngestStats {
  received: number;
  invalidDropped: number;
  flowsStarted: number;
  flowsCompleted: number;
  scopeViolations: number;
  attributedFlows: number;
  browserFlows: number;
  ready: boolean;
}

export class FlowIngestor {
  private readonly pending = new Map<string, TrafficFlow>();
  private ready = false;
  private readonly stats: IngestStats = {
    received: 0,
    invalidDropped: 0,
    flowsStarted: 0,
    flowsCompleted: 0,
    scopeViolations: 0,
    attributedFlows: 0,
    browserFlows: 0,
    ready: false,
  };

  constructor(private readonly opts: FlowIngestorOptions) {}

  getStats(): IngestStats {
    return { ...this.stats, ready: this.ready };
  }

  handle(ev: ProxyEvent): void {
    this.stats.received++;
    switch (ev.kind) {
      case "addon_ready":
        this.ready = true;
        this.stats.ready = true;
        this.opts.emit({
          type: "log",
          level: "info",
          message: `proxy addon ready (v${ev.addonVersion})`,
        });
        break;
      case "flow_start":
        this.onFlowStart(ev);
        break;
      case "flow_request":
        this.onFlowRequest(ev);
        break;
      case "flow_response":
        this.onFlowResponse(ev);
        break;
      case "flow_error":
        this.opts.emit({
          type: "log",
          level: "warn",
          message: `flow error: ${ev.error}`,
          detail: { flowKey: ev.flowKey },
        });
        break;
      case "websocket_message":
        this.onWebsocketMessage(ev);
        break;
      case "scope_violation":
        this.onScopeViolation(ev);
        break;
      case "intercept_pending":
        this.onInterceptPending(ev);
        break;
      case "intercept_decision":
        this.onInterceptDecision(ev);
        break;
    }
  }

  // ---------------------------------------------------------------------------

  private onFlowStart(ev: Extract<ProxyEvent, { kind: "flow_start" }>): void {
    const source: FlowSource =
      ev.sourceHint === "replay" || ev.sourceHint === "agent" ? ev.sourceHint : "browser";
    // Python side sends epoch SECONDS (time.time()); JS works in milliseconds.
    const tsStartMs = ev.timestampStart * 1000;
    const attribution = this.opts.correlator.attribute({
      timestampStart: tsStartMs,
      method: ev.method,
      url: ev.url,
    });
    const flow: TrafficFlow = {
      id: newId("flow"),
      sessionId: this.opts.sessionId,
      proxyFlowKey: ev.flowKey,
      timestampStart: tsStartMs,
      method: ev.method,
      url: ev.url,
      host: ev.host,
      port: ev.port,
      path: ev.path,
      requestHeaders: {},
      responseHeaders: {},
      source,
      browserActionId: attribution.actionId,
      browserPageId: attribution.pageId,
      initiatorUrl: attribution.initiatorUrl,
      timing: {},
      securityMetadata: attribution.method === "none" ? {} : {},
    };
    this.pending.set(ev.flowKey, flow);
    this.opts.flows.save(flow);
    this.stats.flowsStarted++;
    if (source === "browser") this.stats.browserFlows++;
    if (attribution.actionId) {
      this.stats.attributedFlows++;
      this.backfillAction(attribution.actionId, flow.id);
    }
    this.opts.emit({ type: "flow", flow: toFlowSummary(flow) });
  }

  private onFlowRequest(ev: Extract<ProxyEvent, { kind: "flow_request" }>): void {
    const flow = this.pending.get(ev.flowKey);
    if (!flow) {
      this.opts.emit({
        type: "log",
        level: "warn",
        message: `flow_request for unknown flowKey ${ev.flowKey} (dropped)`,
      });
      return;
    }
    flow.requestHeaders = pairsToRecord(ev.headers);
    if (ev.body) {
      const bytes = Buffer.from(ev.body.b64, "base64");
      flow.requestBody = this.opts.bodies.putRef(bytes, {
        mimeType: flow.requestHeaders["content-type"] ?? flow.requestHeaders["Content-Type"],
        truncated: ev.body.truncated,
      });
    }
    flow.timestampEnd = ev.timestampEnd * 1000;
    this.opts.flows.save(flow);
    this.opts.emit({ type: "flow_update", flow: toFlowSummary(flow) });
  }

  private onFlowResponse(ev: Extract<ProxyEvent, { kind: "flow_response" }>): void {
    const flow = this.pending.get(ev.flowKey);
    if (!flow) {
      this.opts.emit({
        type: "log",
        level: "warn",
        message: `flow_response for unknown flowKey ${ev.flowKey} (dropped)`,
      });
      return;
    }
    flow.statusCode = ev.statusCode;
    flow.responseHeaders = pairsToRecord(ev.headers);
    flow.contentType = ev.contentType ?? flow.responseHeaders["content-type"];
    if (ev.body) {
      const bytes = Buffer.from(ev.body.b64, "base64");
      flow.responseBody = this.opts.bodies.putRef(bytes, {
        mimeType: flow.contentType,
        truncated: ev.body.truncated,
      });
    }
    if (ev.timing) {
      flow.timing = {
        dnsMs: ev.timing.dnsMs,
        connectMs: ev.timing.connectMs,
        tlsMs: ev.timing.tlsMs,
        ttfbMs: ev.timing.ttfbMs,
        totalMs: ev.timing.totalMs,
      };
    }
    flow.timestampEnd = ev.timestampEnd * 1000;
    this.opts.flows.save(flow);
    this.stats.flowsCompleted++;
    this.pending.delete(ev.flowKey);
    this.opts.emit({ type: "flow_update", flow: toFlowSummary(flow) });
  }

  private onWebsocketMessage(ev: Extract<ProxyEvent, { kind: "websocket_message" }>): void {
    const flow = this.pending.get(ev.flowKey);
    if (!flow) return;
    flow.websocketMessages = [
      ...(flow.websocketMessages ?? []),
      { fromClient: ev.fromClient, payloadB64: ev.payloadB64, timestamp: ev.timestamp * 1000 },
    ];
    this.opts.flows.save(flow);
  }

  private onScopeViolation(ev: Extract<ProxyEvent, { kind: "scope_violation" }>): void {
    this.stats.scopeViolations++;
    const audit: AuditEvent = {
      id: newId("aud"),
      timestamp: ev.timestamp * 1000,
      actor: "system",
      eventType: "scope_check",
      decision: "blocked",
      reason: `${ev.reason} (enforced at proxy)`,
      details: { method: ev.method, url: ev.url, host: ev.host },
    };
    this.opts.audit.append(audit);
    this.opts.emit({ type: "audit", event: audit });
    this.opts.emit({
      type: "log",
      level: "warn",
      message: `SCOPE VIOLATION blocked at proxy: ${ev.method} ${ev.url}`,
    });
  }

  private onInterceptPending(ev: Extract<ProxyEvent, { kind: "intercept_pending" }>): void {
    const flow = this.pending.get(ev.flowKey);
    if (!flow) return;
    const flags = new Set(flow.securityMetadata.passiveFlags ?? []);
    flags.add("intercept-pending");
    flow.securityMetadata.passiveFlags = [...flags];
    this.opts.flows.save(flow);
    this.opts.emit({ type: "flow_update", flow: toFlowSummary(flow) });
  }

  private onInterceptDecision(ev: Extract<ProxyEvent, { kind: "intercept_decision" }>): void {
    const flow = this.pending.get(ev.flowKey);
    if (!flow) return;
    const flags = new Set(flow.securityMetadata.passiveFlags ?? []);
    flags.delete("intercept-pending");
    if (ev.action === "drop") flags.add("intercept-dropped");
    flow.securityMetadata.passiveFlags = [...flags];
    this.opts.flows.save(flow);
    this.opts.emit({ type: "flow_update", flow: toFlowSummary(flow) });
  }

  /** burpwn-style backfill: the action learns which flows it produced (ADR-003). */
  private backfillAction(actionId: string, flowId: string): void {
    const action = this.opts.actions.get(actionId);
    if (!action) return;
    if (!action.correlatedFlowIds.includes(flowId)) {
      action.correlatedFlowIds.push(flowId);
      this.opts.actions.save(action);
    }
  }
}
