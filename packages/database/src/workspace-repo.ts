import type { DatabaseSync } from "node:sqlite";
import type { AgentWorkspace, Project, ProjectAsset } from "@kanna/shared";

function projectFrom(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description == null ? undefined : String(row.description),
    workspacePath: String(row.workspace_path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function assetFrom(row: Record<string, unknown>): ProjectAsset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    type: String(row.type) as ProjectAsset["type"],
    name: String(row.name),
    value: String(row.value),
    metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    createdAt: Number(row.created_at),
  };
}

function agentFrom(row: Record<string, unknown>): AgentWorkspace {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    thinkingLevel: String(row.thinking_level ?? "medium") as AgentWorkspace["thinkingLevel"],
    cwd: String(row.cwd),
    systemPrompt: String(row.system_prompt),
    toolProfile: String(row.tool_profile) as AgentWorkspace["toolProfile"],
    piSessionFile: row.pi_session_file == null ? undefined : String(row.pi_session_file),
    status: String(row.status) as AgentWorkspace["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastError: row.last_error == null ? undefined : String(row.last_error),
  };
}

export class ProjectsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(project: Project): void {
    this.db
      .prepare(`
      INSERT INTO projects (id, name, description, workspace_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description,
        workspace_path=excluded.workspace_path, updated_at=excluded.updated_at
    `)
      .run(
        project.id,
        project.name,
        project.description ?? null,
        project.workspacePath,
        project.createdAt,
        project.updatedAt,
      );
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? projectFrom(row) : undefined;
  }

  list(): Project[] {
    return (
      this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as Record<string, unknown>[]
    ).map(projectFrom);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
  }
}

export class ProjectAssetsRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(asset: ProjectAsset): void {
    this.db
      .prepare(`
      INSERT INTO project_assets (id, project_id, type, name, value, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        asset.id,
        asset.projectId,
        asset.type,
        asset.name,
        asset.value,
        JSON.stringify(asset.metadata),
        asset.createdAt,
      );
  }

  list(projectId: string): ProjectAsset[] {
    return (
      this.db
        .prepare("SELECT * FROM project_assets WHERE project_id = ? ORDER BY created_at")
        .all(projectId) as Record<string, unknown>[]
    ).map(assetFrom);
  }
}

export class AgentWorkspacesRepo {
  constructor(private readonly db: DatabaseSync) {}

  save(agent: AgentWorkspace): void {
    this.db
      .prepare(`
      INSERT INTO agent_workspaces (
        id, project_id, name, provider_id, model_id, thinking_level, cwd, system_prompt,
        tool_profile, pi_session_file, status, created_at, updated_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, provider_id=excluded.provider_id, model_id=excluded.model_id,
        thinking_level=excluded.thinking_level, cwd=excluded.cwd,
        system_prompt=excluded.system_prompt, tool_profile=excluded.tool_profile,
        pi_session_file=excluded.pi_session_file, status=excluded.status,
        updated_at=excluded.updated_at, last_error=excluded.last_error
    `)
      .run(
        agent.id,
        agent.projectId,
        agent.name,
        agent.providerId,
        agent.modelId,
        agent.thinkingLevel,
        agent.cwd,
        agent.systemPrompt,
        agent.toolProfile,
        agent.piSessionFile ?? null,
        agent.status,
        agent.createdAt,
        agent.updatedAt,
        agent.lastError ?? null,
      );
  }

  get(id: string): AgentWorkspace | undefined {
    const row = this.db.prepare("SELECT * FROM agent_workspaces WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? agentFrom(row) : undefined;
  }

  list(projectId?: string): AgentWorkspace[] {
    const rows = projectId
      ? this.db
          .prepare("SELECT * FROM agent_workspaces WHERE project_id = ? ORDER BY updated_at DESC")
          .all(projectId)
      : this.db.prepare("SELECT * FROM agent_workspaces ORDER BY updated_at DESC").all();
    return (rows as Record<string, unknown>[]).map(agentFrom);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM agent_workspaces WHERE id = ?").run(id).changes > 0;
  }
}
