import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "@kanna/shared";

export interface SessionRow {
  id: string;
  startedAt: number;
  target?: string;
  scope: Scope;
  endedAt?: number;
}

export class SessionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(row: SessionRow): void {
    this.db
      .prepare(
        "INSERT INTO sessions (id, started_at, target, scope_json, ended_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.startedAt, row.target ?? null, JSON.stringify(row.scope), null);
  }

  end(id: string, endedAt = Date.now()): void {
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(endedAt, id);
  }

  get(id: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      startedAt: Number(r.started_at),
      target: r.target == null ? undefined : String(r.target),
      scope: JSON.parse(String(r.scope_json)) as Scope,
      endedAt: r.ended_at == null ? undefined : Number(r.ended_at),
    };
  }

  list(): Array<SessionRow> {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY started_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      startedAt: Number(r.started_at),
      target: r.target == null ? undefined : String(r.target),
      scope: JSON.parse(String(r.scope_json)) as Scope,
      endedAt: r.ended_at == null ? undefined : Number(r.ended_at),
    }));
  }
}
