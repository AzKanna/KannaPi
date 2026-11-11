import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionsRepo, BodyStore, FlowsRepo, openDatabase, SessionsRepo } from "@kanna/database";
import { afterEach, describe, expect, test } from "vitest";
import { TrafficWorkspaceService } from "./traffic-workspace.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function service() {
  const directory = await mkdtemp(join(tmpdir(), "kanna-traffic-workspace-"));
  dirs.push(directory);
  const db = openDatabase(join(directory, "kanna.db"));
  const bodies = new BodyStore(db);
  return {
    db,
    value: new TrafficWorkspaceService(
      new SessionsRepo(db),
      new ActionsRepo(db),
      new FlowsRepo(db, bodies),
      bodies,
    ),
  };
}

describe("TrafficWorkspaceService", () => {
  test("creates an idempotent demo capture with bounded flow detail", async () => {
    const { db, value } = await service();
    try {
      const created = value.createDemoCapture();
      expect(value.createDemoCapture().id).toBe(created.id);
      expect(created.flowCount).toBe(4);
      expect(created.actionCount).toBe(2);
      const rows = value.listFlows(created.id, { limit: 100 });
      expect(rows.total).toBe(4);
      const selected = rows.rows.find((row) => row.path.includes("/account/orders/"));
      if (!selected) throw new Error("Expected demo order flow");
      const detail = value.getDetail(created.id, selected.id);
      expect(detail?.responseBodyText).toContain("ORD-8821");
      expect(detail?.action?.type).toBe("click");
    } finally {
      db.close();
    }
  });

  test("redacts captured secrets before constructing Agent evidence", async () => {
    const { db, value } = await service();
    try {
      const created = value.createDemoCapture();
      const login = value
        .listFlows(created.id, { limit: 100 })
        .rows.find((row) => row.path === "/api/auth/login");
      if (!login) throw new Error("Expected demo login flow");
      const prompt = value.analysisPrompt(created.id, login.id);
      expect(prompt).toContain("<traffic_evidence>");
      expect(prompt).toContain("[REDACTED]");
      expect(prompt).not.toContain("demo-password");
      expect(prompt).not.toContain("demo-access-token");
      expect(prompt).not.toContain("demo-session-token");
    } finally {
      db.close();
    }
  });
});
