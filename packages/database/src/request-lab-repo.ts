import type { DatabaseSync } from "node:sqlite";
import type { RequestLabExchange, RequestLabTab } from "@kanna/shared";
import { asJsonOr, asNum, asStr } from "./sql-utils.js";

function tabFrom(row: Record<string, unknown>): RequestLabTab {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    sourceSessionId: asStr(row.source_session_id),
    sourceFlowId: asStr(row.source_flow_id),
    allowedOrigin: String(row.allowed_origin),
    rawRequest: String(row.raw_request),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function exchangeFrom(row: Record<string, unknown>): RequestLabExchange {
  return {
    id: String(row.id),
    tabId: String(row.tab_id),
    requestUrl: String(row.request_url),
    rawRequest: String(row.raw_request),
    statusCode: asNum(row.response_status),
    statusText: asStr(row.response_status_text),
    responseHeaders: asJsonOr<Record<string, string>>(row.response_headers_json, {}),
    responseBody: String(row.response_body),
    responseTruncated: Boolean(row.response_truncated),
    durationMs: asNum(row.duration_ms),
    error: asStr(row.error),
    createdAt: Number(row.created_at),
  };
}

export class RequestLabRepo {
  constructor(private readonly db: DatabaseSync) {}

  saveTab(tab: RequestLabTab): void {
    this.db
      .prepare(`
      INSERT INTO request_lab_tabs (
        id, project_id, name, source_session_id, source_flow_id, allowed_origin,
        raw_request, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, raw_request=excluded.raw_request, updated_at=excluded.updated_at
    `)
      .run(
        tab.id,
        tab.projectId,
        tab.name,
        tab.sourceSessionId ?? null,
        tab.sourceFlowId ?? null,
        tab.allowedOrigin,
        tab.rawRequest,
        tab.createdAt,
        tab.updatedAt,
      );
  }

  getTab(id: string): RequestLabTab | undefined {
    const row = this.db.prepare("SELECT * FROM request_lab_tabs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? tabFrom(row) : undefined;
  }

  listTabs(projectId: string): RequestLabTab[] {
    const rows = this.db
      .prepare("SELECT * FROM request_lab_tabs WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as Record<string, unknown>[];
    return rows.map(tabFrom);
  }

  deleteTab(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM request_lab_tabs WHERE id = ?").run(id).changes) > 0;
  }

  saveExchange(exchange: RequestLabExchange): void {
    this.db
      .prepare(`
      INSERT INTO request_lab_exchanges (
        id, tab_id, request_url, raw_request, response_status,
        response_status_text, response_headers_json, response_body,
        response_truncated, duration_ms, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        exchange.id,
        exchange.tabId,
        exchange.requestUrl,
        exchange.rawRequest,
        exchange.statusCode ?? null,
        exchange.statusText ?? null,
        JSON.stringify(exchange.responseHeaders),
        exchange.responseBody,
        exchange.responseTruncated ? 1 : 0,
        exchange.durationMs ?? null,
        exchange.error ?? null,
        exchange.createdAt,
      );
  }

  listExchanges(tabId: string, limit = 50): RequestLabExchange[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare("SELECT * FROM request_lab_exchanges WHERE tab_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(tabId, bounded) as Record<string, unknown>[];
    return rows.map(exchangeFrom);
  }

  getExchanges(tabId: string, ids: string[]): RequestLabExchange[] {
    if (!ids.length) return [];
    const unique = [...new Set(ids)].slice(0, 2);
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM request_lab_exchanges WHERE tab_id = ? AND id IN (${placeholders})`)
      .all(tabId, ...unique) as Record<string, unknown>[];
    return rows.map(exchangeFrom);
  }
}
