import type { DatabaseSync } from "node:sqlite";
import type { AgentChatSession } from "@kanna/shared";

function fromRow(row: Record<string, unknown>): AgentChatSession {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    workspacePath: String(row.workspace_path),
    piSessionFile: row.pi_session_file == null ? undefined : String(row.pi_session_file),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class AgentChatSessionsRepo {
  constructor(private readonly db: DatabaseSync) {}

  isInitialized(agentId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM agent_chat_session_state WHERE agent_id = ?").get(agentId));
  }

  markInitialized(agentId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO agent_chat_session_state (agent_id) VALUES (?)").run(agentId);
  }

  save(session: AgentChatSession): void {
    this.db
      .prepare(`
      INSERT INTO agent_chat_sessions (
        id, agent_id, name, workspace_path, pi_session_file, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        workspace_path=excluded.workspace_path,
        pi_session_file=excluded.pi_session_file,
        updated_at=excluded.updated_at
    `)
      .run(
        session.id,
        session.agentId,
        session.name,
        session.workspacePath,
        session.piSessionFile ?? null,
        session.createdAt,
        session.updatedAt,
      );
  }

  get(agentId: string, id: string): AgentChatSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_chat_sessions WHERE agent_id = ? AND id = ?")
      .get(agentId, id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(agentId: string): AgentChatSession[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM agent_chat_sessions WHERE agent_id = ? ORDER BY updated_at DESC, created_at DESC",
        )
        .all(agentId) as Record<string, unknown>[]
    ).map(fromRow);
  }

  count(agentId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_chat_sessions WHERE agent_id = ?")
      .get(agentId) as { count: number };
    return Number(row.count);
  }

  delete(agentId: string, id: string): boolean {
    return (
      this.db.prepare("DELETE FROM agent_chat_sessions WHERE agent_id = ? AND id = ?").run(agentId, id)
        .changes > 0
    );
  }
}
