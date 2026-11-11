import type { DatabaseSync } from "node:sqlite";
import type { AgentMcpServer, AgentPluginCapability, AgentSkillCapability, McpTransport } from "@kanna/shared";

export interface StoredMcpServer extends AgentMcpServer {
  env: Record<string, string>;
}

function strings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function skillFrom(row: Record<string, unknown>): AgentSkillCapability {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    path: String(row.path),
    names: strings(row.names_json),
    descriptions: strings(row.descriptions_json),
    enabled: Boolean(row.enabled),
    createdAt: Number(row.created_at),
  };
}

function mcpFrom(row: Record<string, unknown>): StoredMcpServer {
  let env: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(row.env_json)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      env = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  } catch {
    // A malformed legacy value should not prevent the rest of the configuration from loading.
  }
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    transport: String(row.transport) as McpTransport,
    command: row.command == null ? undefined : String(row.command),
    args: strings(row.args_json),
    url: row.url == null ? undefined : String(row.url),
    env,
    envKeys: Object.keys(env).sort(),
    enabled: Boolean(row.enabled),
    toolNames: strings(row.tool_names_json),
    lastError: row.last_error == null ? undefined : String(row.last_error),
    lastCheckedAt: row.last_checked_at == null ? undefined : Number(row.last_checked_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class AgentSkillsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(skill: AgentSkillCapability): void {
    this.db.prepare(`
      INSERT INTO agent_skills (id, agent_id, path, names_json, descriptions_json, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, names_json=excluded.names_json,
        descriptions_json=excluded.descriptions_json, enabled=excluded.enabled
    `).run(skill.id, skill.agentId, skill.path, JSON.stringify(skill.names),
      JSON.stringify(skill.descriptions), skill.enabled ? 1 : 0, skill.createdAt);
  }

  list(agentId: string): AgentSkillCapability[] {
    return (this.db.prepare("SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY created_at").all(agentId) as Record<string, unknown>[]).map(skillFrom);
  }

  delete(agentId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM agent_skills WHERE agent_id = ? AND id = ?").run(agentId, id).changes) > 0;
  }
}

export class AgentPluginsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(plugin: AgentPluginCapability): void {
    this.db.prepare(`INSERT INTO agent_plugins (id, agent_id, name, path, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, path=excluded.path, enabled=excluded.enabled`)
      .run(plugin.id, plugin.agentId, plugin.name, plugin.path, plugin.enabled ? 1 : 0, plugin.createdAt);
  }

  list(agentId: string): AgentPluginCapability[] {
    return (this.db.prepare("SELECT * FROM agent_plugins WHERE agent_id = ? ORDER BY created_at")
      .all(agentId) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), agentId: String(row.agent_id), name: String(row.name),
      path: String(row.path), enabled: Boolean(row.enabled), createdAt: Number(row.created_at),
    }));
  }

  get(agentId: string, id: string): AgentPluginCapability | undefined {
    return this.list(agentId).find((plugin) => plugin.id === id);
  }

  delete(agentId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM agent_plugins WHERE agent_id = ? AND id = ?")
      .run(agentId, id).changes) > 0;
  }
}

export class AgentMcpServersRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(server: StoredMcpServer): void {
    this.db.prepare(`
      INSERT INTO agent_mcp_servers (
        id, agent_id, name, transport, command, args_json, url, env_json, enabled,
        tool_names_json, last_error, last_checked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, transport=excluded.transport,
        command=excluded.command, args_json=excluded.args_json, url=excluded.url,
        env_json=excluded.env_json, enabled=excluded.enabled,
        tool_names_json=excluded.tool_names_json, last_error=excluded.last_error,
        last_checked_at=excluded.last_checked_at, updated_at=excluded.updated_at
    `).run(server.id, server.agentId, server.name, server.transport, server.command ?? null,
      JSON.stringify(server.args), server.url ?? null, JSON.stringify(server.env), server.enabled ? 1 : 0,
      JSON.stringify(server.toolNames), server.lastError ?? null, server.lastCheckedAt ?? null,
      server.createdAt, server.updatedAt);
  }

  get(agentId: string, id: string): StoredMcpServer | undefined {
    const row = this.db.prepare("SELECT * FROM agent_mcp_servers WHERE agent_id = ? AND id = ?").get(agentId, id) as Record<string, unknown> | undefined;
    return row ? mcpFrom(row) : undefined;
  }

  list(agentId: string): StoredMcpServer[] {
    return (this.db.prepare("SELECT * FROM agent_mcp_servers WHERE agent_id = ? ORDER BY created_at").all(agentId) as Record<string, unknown>[]).map(mcpFrom);
  }

  delete(agentId: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM agent_mcp_servers WHERE agent_id = ? AND id = ?").run(agentId, id).changes) > 0;
  }
}
