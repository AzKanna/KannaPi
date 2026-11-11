import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AuditEvent } from "@kanna/shared";
import { asJson, asStr } from "./sql-utils.js";

export interface AuditFilter {
  sinceTs?: number;
  eventType?: string;
  decision?: string;
  limit: number;
  offset: number;
}

function rowToEvent(r: Record<string, unknown>): AuditEvent {
  return {
    id: String(r.id),
    timestamp: Number(r.ts),
    actor: String(r.actor) as AuditEvent["actor"],
    eventType: String(r.event_type) as AuditEvent["eventType"],
    toolName: asStr(r.tool_name),
    actionId: asStr(r.action_id),
    flowId: asStr(r.flow_id),
    decision: asStr(r.decision) as AuditEvent["decision"],
    reason: asStr(r.reason),
    details: asJson<Record<string, unknown>>(r.details),
  };
}

/** Append-only audit trail (ADR-004) — JSONL mirror is written by the server layer. */
export class AuditRepo {
  constructor(private readonly db: DatabaseSync) {}

  append(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit (id, ts, actor, event_type, tool_name, action_id, flow_id, decision, reason, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.timestamp,
        event.actor,
        event.eventType,
        event.toolName ?? null,
        event.actionId ?? null,
        event.flowId ?? null,
        event.decision ?? null,
        event.reason ?? null,
        event.details ? JSON.stringify(event.details) : null,
      );
  }

  list(filter: AuditFilter): AuditEvent[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.sinceTs) {
      where.push("ts >= ?");
      params.push(filter.sinceTs);
    }
    if (filter.eventType) {
      where.push("event_type = ?");
      params.push(filter.eventType);
    }
    if (filter.decision) {
      where.push("decision = ?");
      params.push(filter.decision);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM audit ${whereSql} ORDER BY ts ASC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit, filter.offset) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM audit").get() as { c: number }).c;
  }
}
