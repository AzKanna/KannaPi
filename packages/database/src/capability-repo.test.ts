import { describe, expect, it } from "vitest";
import type { AgentWorkspace, Project } from "@kanna/shared";
import { AgentMcpServersRepo, AgentPluginsRepo, AgentSkillsRepo } from "./capability-repo.js";
import { openDatabase } from "./db.js";
import { AgentWorkspacesRepo, ProjectsRepo } from "./workspace-repo.js";

function seed() {
  const db = openDatabase(":memory:");
  const now = Date.now();
  const project: Project = { id: "prj_test", name: "Test", workspacePath: process.cwd(), createdAt: now, updatedAt: now };
  const agent: AgentWorkspace = {
    id: "agent_test", projectId: project.id, name: "Agent", providerId: "test", modelId: "test", thinkingLevel: "medium",
    cwd: process.cwd(), systemPrompt: "test", toolProfile: "read-only", status: "idle", createdAt: now, updatedAt: now,
  };
  new ProjectsRepo(db).save(project);
  new AgentWorkspacesRepo(db).save(agent);
  return { db, now };
}

describe("capability repositories", () => {
  it("persists Skill attachments and MCP secrets separately from public metadata", () => {
    const { db, now } = seed();
    const skills = new AgentSkillsRepo(db);
    const servers = new AgentMcpServersRepo(db);
    skills.save({ id: "skill_test", agentId: "agent_test", path: "C:\\skills\\demo", names: ["demo"], descriptions: ["Demo skill"], enabled: true, createdAt: now });
    servers.save({
      id: "mcp_test", agentId: "agent_test", name: "Demo MCP", transport: "stdio", command: "node",
      args: ["server.js"], env: { API_KEY: "secret" }, envKeys: ["API_KEY"], enabled: true,
      toolNames: ["mcp__demo_mcp__echo"], createdAt: now, updatedAt: now,
    });

    expect(skills.list("agent_test")[0]?.names).toEqual(["demo"]);
    expect(servers.list("agent_test")[0]).toMatchObject({ env: { API_KEY: "secret" }, envKeys: ["API_KEY"] });
    db.close();
  });

  it("persists per-Agent Pi Plugins and their enabled state", () => {
    const { db, now } = seed();
    const plugins = new AgentPluginsRepo(db);
    const plugin = { id: "plugin_test", agentId: "agent_test", name: "sample.ts", path: "C:\\plugins\\sample.ts", enabled: true, createdAt: now };
    plugins.save(plugin);
    expect(plugins.list("agent_test")).toEqual([plugin]);
    plugins.save({ ...plugin, enabled: false });
    expect(plugins.get("agent_test", plugin.id)?.enabled).toBe(false);
    expect(plugins.delete("agent_test", plugin.id)).toBe(true);
    expect(plugins.list("agent_test")).toEqual([]);
    db.close();
  });
});
