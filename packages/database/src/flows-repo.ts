import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { BodyRef, FlowSource, TrafficFlow, TrafficFlowSummary } from "@kanna/shared";
import type { BodyStore } from "./body-store.js";
import { asJson, asJsonOr, asNum, asStr } from "./sql-utils.js";

export interface FlowFilter {
  host?: string;
  pathPrefix?: string;
  method?: string;
  statusCode?: number;
  actionId?: string;
  source?: FlowSource;
  sinceTs?: number;
  limit: number;
  offset: number;
}

interface BodyColumns {
  hash: unknown;
  size: unknown;
  truncated: unknown;
  mime: unknown;
  preview: unknown;
}

function bodyFromColumns(c: BodyColumns): BodyRef | undefined {
  const hash = asStr(c.hash);
  if (hash === undefined) return undefined;
  return {
    blobHash: hash,
    size: asNum(c.size) ?? 0,
    truncated: Boolean(c.truncated),
    mimeType: asStr(c.mime),
    textPreview: asStr(c.preview),
  };
}

function rowToFlow(r: Record<string, unknown>): TrafficFlow {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    proxyFlowKey: String(r.proxy_flow_key),
    timestampStart: Number(r.ts_start),
    timestampEnd: asNum(r.ts_end),
    method: String(r.method),
    url: String(r.url),
    host: String(r.host),
    port: asNum(r.port),
    path: String(r.path),
    requestHeaders: asJsonOr<Record<string, string>>(r.request_headers, {}),
    requestBody: bodyFromColumns({
      hash: r.request_body_hash,
      size: r.request_body_size,
      truncated: r.request_body_truncated,
      mime: r.request_body_mime,
      preview: r.request_body_preview,
    }),
    statusCode: asNum(r.status_code),
    responseHeaders: asJsonOr<Record<string, string>>(r.response_headers, {}),
    responseBody: bodyFromColumns({
      hash: r.response_body_hash,
      size: r.response_body_size,
      truncated: r.response_body_truncated,
      mime: r.response_body_mime,
      preview: r.response_body_preview,
    }),
    contentType: asStr(r.content_type),
    source: String(r.source) as TrafficFlow["source"],
    browserActionId: asStr(r.browser_action_id),
    browserPageId: asStr(r.browser_page_id),
    initiatorUrl: asStr(r.initiator_url),
    timing: asJsonOr<TrafficFlow["timing"]>(r.timing, {}),
    securityMetadata: asJsonOr<TrafficFlow["securityMetadata"]>(r.security_metadata, {}),
    websocketMessages: asJson<TrafficFlow["websocketMessages"]>(r.websocket_messages),
  };
}

/**
 * Whole-row upsert per event (flow_start → flow_request → flow_response).
 * At most three writes per flow — cheap compared to body dedup savings.
 * Bodies are stored by the caller (ingest) via BodyStore; this repo persists refs only.
 */
export class FlowsRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly bodies: BodyStore,
  ) {}

  save(flow: TrafficFlow): void {
    const req = flow.requestBody;
    const res = flow.responseBody;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO flows (
          id, session_id, proxy_flow_key, ts_start, ts_end, method, url, host, port, path,
          request_headers, request_body_hash, request_body_size, request_body_truncated,
          request_body_mime, request_body_preview,
          status_code, response_headers, response_body_hash, response_body_size,
          response_body_truncated, response_body_mime, response_body_preview,
          content_type, source, browser_action_id, browser_page_id, initiator_url,
          timing, security_metadata, websocket_messages, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flow.id,
        flow.sessionId,
        flow.proxyFlowKey,
        flow.timestampStart,
        flow.timestampEnd ?? null,
        flow.method,
        flow.url,
        flow.host,
        flow.port ?? null,
        flow.path,
        JSON.stringify(flow.requestHeaders),
        req?.blobHash ?? null,
        req?.size ?? null,
        req ? (req.truncated ? 1 : 0) : null,
        req?.mimeType ?? null,
        req?.textPreview ?? null,
        flow.statusCode ?? null,
        JSON.stringify(flow.responseHeaders),
        res?.blobHash ?? null,
        res?.size ?? null,
        res ? (res.truncated ? 1 : 0) : null,
        res?.mimeType ?? null,
        res?.textPreview ?? null,
        flow.contentType ?? null,
        flow.source,
        flow.browserActionId ?? null,
        flow.browserPageId ?? null,
        flow.initiatorUrl ?? null,
        JSON.stringify(flow.timing),
        JSON.stringify(flow.securityMetadata),
        flow.websocketMessages ? JSON.stringify(flow.websocketMessages) : null,
        Date.now(),
      );
  }

  get(id: string): TrafficFlow | undefined {
    const r = this.db.prepare("SELECT * FROM flows WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToFlow(r) : undefined;
  }

  getByProxyKey(sessionId: string, proxyFlowKey: string): TrafficFlow | undefined {
    const r = this.db
      .prepare("SELECT * FROM flows WHERE session_id = ? AND proxy_flow_key = ?")
      .get(sessionId, proxyFlowKey) as Record<string, unknown> | undefined;
    return r ? rowToFlow(r) : undefined;
  }

  list(sessionId: string, filter: FlowFilter): { rows: TrafficFlowSummary[]; total: number } {
    const where: string[] = ["session_id = ?"];
    const params: SQLInputValue[] = [sessionId];
    if (filter.host) {
      where.push("host = ?");
      params.push(filter.host);
    }
    if (filter.pathPrefix) {
      where.push("path LIKE ?");
      params.push(`${filter.pathPrefix}%`);
    }
    if (filter.method) {
      where.push("method = ?");
      params.push(filter.method.toUpperCase());
    }
    if (filter.statusCode) {
      where.push("status_code = ?");
      params.push(filter.statusCode);
    }
    if (filter.actionId) {
      where.push("browser_action_id = ?");
      params.push(filter.actionId);
    }
    if (filter.source) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.sinceTs) {
      where.push("ts_start >= ?");
      params.push(filter.sinceTs);
    }
    const whereSql = where.join(" AND ");
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM flows WHERE ${whereSql}`).get(...params) as {
        c: number;
      }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT id, ts_start, method, url, host, path, status_code, content_type, source,
                browser_action_id, request_body_size, response_body_size,
                timing, security_metadata, request_body_preview, response_body_preview
         FROM flows WHERE ${whereSql}
         ORDER BY ts_start DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as Array<Record<string, unknown>>;
    return {
      rows: rows.map((r) => {
        const flags = asJsonOr<TrafficFlow["securityMetadata"]>(r.security_metadata, {}).passiveFlags ?? [];
        return {
          id: String(r.id),
          timestampStart: Number(r.ts_start),
          method: String(r.method),
          url: String(r.url),
          host: String(r.host),
          path: String(r.path),
          statusCode: asNum(r.status_code),
          contentType: asStr(r.content_type),
          source: String(r.source) as TrafficFlow["source"],
          browserActionId: asStr(r.browser_action_id),
          requestSize: asNum(r.request_body_size),
          responseSize: asNum(r.response_body_size),
          totalMs: asJsonOr<TrafficFlow["timing"]>(r.timing, {}).totalMs,
          interceptStatus: flags.includes("intercept-pending")
            ? ("pending" as const)
            : flags.includes("intercept-dropped")
              ? ("dropped" as const)
              : undefined,
        };
      }),
      total,
    };
  }

  listByAction(actionId: string): TrafficFlow[] {
    const rows = this.db
      .prepare("SELECT * FROM flows WHERE browser_action_id = ? ORDER BY ts_start ASC")
      .all(actionId) as Array<Record<string, unknown>>;
    return rows.map(rowToFlow);
  }

  recent(sessionId: string, sinceTs: number, limit = 50): TrafficFlow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM flows WHERE session_id = ? AND ts_start >= ? ORDER BY ts_start ASC LIMIT ?",
      )
      .all(sessionId, sinceTs, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToFlow);
  }

  /** Newest bounded flow set, returned in chronological order for deterministic aggregation. */
  listForSession(sessionId: string, limit = 2_000): TrafficFlow[] {
    const bounded = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM flows WHERE session_id = ? ORDER BY ts_start DESC, id DESC LIMIT ?
         ) ORDER BY ts_start ASC, id ASC`,
      )
      .all(sessionId, bounded) as Array<Record<string, unknown>>;
    return rows.map(rowToFlow);
  }

  countBySession(sessionId: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM flows WHERE session_id = ?").get(sessionId) as {
        c: number;
      }
    ).c;
  }

  /** Raw body bytes for evidence / tool output. */
  getBodyBytes(hash: string): Uint8Array | undefined {
    return this.bodies.get(hash);
  }
}
