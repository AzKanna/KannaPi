import type { DatabaseSync } from "node:sqlite";
import type { AttackGraph } from "@kanna/shared";

export class AttackGraphsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(graph: AttackGraph): void {
    this.db
      .prepare(`
      INSERT INTO agent_attack_graphs (agent_id, run_id, graph_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        run_id=excluded.run_id, graph_json=excluded.graph_json, updated_at=excluded.updated_at
    `)
      .run(graph.agentId, graph.runId, JSON.stringify(graph), Date.now());
    if (graph.sessionId) {
      this.db.prepare(`
        INSERT INTO agent_session_attack_graphs (session_id, agent_id, graph_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id, session_id) DO UPDATE SET
          graph_json=excluded.graph_json, updated_at=excluded.updated_at
      `).run(graph.sessionId, graph.agentId, JSON.stringify(graph), Date.now());
    }
  }

  get(agentId: string): AttackGraph | undefined {
    const row = this.db
      .prepare("SELECT graph_json FROM agent_attack_graphs WHERE agent_id = ?")
      .get(agentId) as { graph_json: string } | undefined;
    return row ? (JSON.parse(row.graph_json) as AttackGraph) : undefined;
  }

  getBySession(agentId: string, sessionId: string): AttackGraph | undefined {
    const row = this.db.prepare("SELECT graph_json FROM agent_session_attack_graphs WHERE agent_id = ? AND session_id = ?")
      .get(agentId, sessionId) as { graph_json: string } | undefined;
    return row ? JSON.parse(row.graph_json) as AttackGraph : undefined;
  }

  deleteBySession(agentId: string, sessionId: string): void {
    this.db.prepare("DELETE FROM agent_session_attack_graphs WHERE agent_id = ? AND session_id = ?")
      .run(agentId, sessionId);
    if (this.get(agentId)?.sessionId === sessionId)
      this.db.prepare("DELETE FROM agent_attack_graphs WHERE agent_id = ?").run(agentId);
  }
}
