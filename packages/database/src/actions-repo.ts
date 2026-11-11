import type { DatabaseSync } from "node:sqlite";
import type { BrowserAction } from "@kanna/shared";
import { asJsonOr, asNum, asStr } from "./sql-utils.js";

function rowToAction(r: Record<string, unknown>): BrowserAction {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    seq: Number(r.seq),
    type: String(r.type) as BrowserAction["type"],
    params: asJsonOr<Record<string, unknown>>(r.params, {}),
    pageId: String(r.page_id),
    startedAt: Number(r.started_at),
    endedAt: asNum(r.ended_at),
    status: String(r.status) as BrowserAction["status"],
    error: asStr(r.error),
    pageUrlBefore: asStr(r.page_url_before),
    pageUrlAfter: asStr(r.page_url_after),
    correlatedFlowIds: asJsonOr<string[]>(r.correlated_flow_ids, []),
  };
}

export class ActionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(action: BrowserAction): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO actions (
          id, session_id, seq, type, params, page_id, started_at, ended_at, status,
          error, page_url_before, page_url_after, correlated_flow_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.sessionId,
        action.seq,
        action.type,
        JSON.stringify(action.params),
        action.pageId,
        action.startedAt,
        action.endedAt ?? null,
        action.status,
        action.error ?? null,
        action.pageUrlBefore ?? null,
        action.pageUrlAfter ?? null,
        JSON.stringify(action.correlatedFlowIds),
      );
  }

  get(id: string): BrowserAction | undefined {
    const r = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToAction(r) : undefined;
  }

  listBySession(sessionId: string, limit = 200, offset = 0): BrowserAction[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM actions WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?",
      )
      .all(sessionId, limit, offset) as Array<Record<string, unknown>>;
    return rows.map(rowToAction);
  }

  countBySession(sessionId: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM actions WHERE session_id = ?").get(sessionId) as {
        c: number;
      }
    ).c;
  }

  /** Back-fill correlated flow ids after attribution (ADR-003). */
  setCorrelatedFlowIds(id: string, flowIds: string[]): void {
    this.db
      .prepare("UPDATE actions SET correlated_flow_ids = ? WHERE id = ?")
      .run(JSON.stringify(flowIds), id);
  }
}
