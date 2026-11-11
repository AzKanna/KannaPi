import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Finding, SecurityHypothesis, SecurityTest } from "@kanna/shared";

/** Agent-authored security documents: JSON blob + extracted query columns. */
export class FindingsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(sessionId: string, finding: Finding): void {
    this.db
      .prepare(
        `INSERT INTO findings (id, session_id, category, severity, status, endpoint, parameter, title, json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           severity = excluded.severity,
           status = excluded.status,
           json = excluded.json,
           updated_at = excluded.updated_at`,
      )
      .run(
        finding.id,
        sessionId,
        finding.category,
        finding.severity,
        finding.status,
        finding.endpoint
          ? `${finding.endpoint.method} ${finding.endpoint.pathTemplate}`
          : null,
        finding.parameter ?? null,
        finding.title,
        JSON.stringify(finding),
        finding.createdAt,
        finding.updatedAt,
      );
  }

  get(id: string): Finding | undefined {
    const r = this.db.prepare("SELECT json FROM findings WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return r ? (JSON.parse(r.json) as Finding) : undefined;
  }

  list(
    sessionId: string,
    filter?: { category?: string; status?: string; severity?: string },
  ): Finding[] {
    const where = ["session_id = ?"];
    const params: SQLInputValue[] = [sessionId];
    if (filter?.category) {
      where.push("category = ?");
      params.push(filter.category);
    }
    if (filter?.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.severity) {
      where.push("severity = ?");
      params.push(filter.severity);
    }
    const rows = this.db
      .prepare(`SELECT json FROM findings WHERE ${where.join(" AND ")} ORDER BY created_at ASC`)
      .all(...params) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Finding);
  }
}

export class HypothesesRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(sessionId: string, h: SecurityHypothesis): void {
    this.db
      .prepare(
        `INSERT INTO hypotheses (id, session_id, category, status, priority, title, json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status,
           json = excluded.json,
           updated_at = excluded.updated_at`,
      )
      .run(
        h.id,
        sessionId,
        h.category,
        h.status,
        h.priority,
        h.title,
        JSON.stringify(h),
        h.createdAt,
        h.updatedAt,
      );
  }

  get(id: string): SecurityHypothesis | undefined {
    const r = this.db.prepare("SELECT json FROM hypotheses WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return r ? (JSON.parse(r.json) as SecurityHypothesis) : undefined;
  }

  list(sessionId: string, status?: string): SecurityHypothesis[] {
    const sql = status
      ? "SELECT json FROM hypotheses WHERE session_id = ? AND status = ? ORDER BY created_at ASC"
      : "SELECT json FROM hypotheses WHERE session_id = ? ORDER BY created_at ASC";
    const params = status ? [sessionId, status] : [sessionId];
    const rows = this.db.prepare(sql).all(...params) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as SecurityHypothesis);
  }
}

export class TestsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(sessionId: string, t: SecurityTest): void {
    this.db
      .prepare(
        `INSERT INTO tests (id, session_id, hypothesis_id, strategy, json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
      )
      .run(t.id, sessionId, t.hypothesisId, t.strategy, JSON.stringify(t), Date.now());
  }

  get(id: string): SecurityTest | undefined {
    const r = this.db.prepare("SELECT json FROM tests WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return r ? (JSON.parse(r.json) as SecurityTest) : undefined;
  }

  listByHypothesis(hypothesisId: string): SecurityTest[] {
    const rows = this.db
      .prepare("SELECT json FROM tests WHERE hypothesis_id = ? ORDER BY created_at ASC")
      .all(hypothesisId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as SecurityTest);
  }
}
