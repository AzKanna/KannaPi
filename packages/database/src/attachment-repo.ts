import type { DatabaseSync } from "node:sqlite";
import type { AgentAttachment } from "@kanna/shared";

export interface StoredAgentAttachment extends AgentAttachment {
  storagePath: string;
}

function fromRow(row: Record<string, unknown>): StoredAgentAttachment {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    mimeType: String(row.mime_type),
    size: Number(row.size),
    storagePath: String(row.storage_path),
    createdAt: Number(row.created_at),
  };
}

export class AgentAttachmentsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(value: StoredAgentAttachment): void {
    this.db
      .prepare(`
      INSERT INTO agent_attachments (id, agent_id, name, mime_type, size, storage_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        value.id,
        value.agentId,
        value.name,
        value.mimeType,
        value.size,
        value.storagePath,
        value.createdAt,
      );
  }

  getMany(agentId: string, ids: string[]): StoredAgentAttachment[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (
      this.db
        .prepare(`SELECT * FROM agent_attachments WHERE agent_id = ? AND id IN (${placeholders})`)
        .all(agentId, ...ids) as Record<string, unknown>[]
    ).map(fromRow);
  }

  list(agentId: string): StoredAgentAttachment[] {
    return (this.db.prepare("SELECT * FROM agent_attachments WHERE agent_id = ?").all(agentId) as Record<string, unknown>[]).map(fromRow);
  }
}
