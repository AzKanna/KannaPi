import type { DatabaseSync } from "node:sqlite";
import type { Endpoint } from "@kanna/shared";

export class EndpointsRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Upsert on (session, host, method, pathTemplate). */
  save(sessionId: string, endpoint: Endpoint): void {
    this.db
      .prepare(
        `INSERT INTO endpoints (id, session_id, host, method, path_template, test_state, first_seen, last_seen, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, host, method, path_template) DO UPDATE SET
           json = excluded.json,
           test_state = excluded.test_state,
           last_seen = excluded.last_seen`,
      )
      .run(
        endpoint.id,
        sessionId,
        endpoint.host,
        endpoint.method,
        endpoint.pathTemplate,
        endpoint.testState,
        endpoint.firstSeen,
        endpoint.lastSeen,
        JSON.stringify(endpoint),
      );
  }

  findByIdentity(
    sessionId: string,
    host: string,
    method: string,
    pathTemplate: string,
  ): Endpoint | undefined {
    const r = this.db
      .prepare(
        "SELECT json FROM endpoints WHERE session_id = ? AND host = ? AND method = ? AND path_template = ?",
      )
      .get(sessionId, host, method, pathTemplate) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Endpoint) : undefined;
  }

  list(sessionId: string): Endpoint[] {
    const rows = this.db
      .prepare("SELECT json FROM endpoints WHERE session_id = ? ORDER BY last_seen DESC")
      .all(sessionId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Endpoint);
  }
}
