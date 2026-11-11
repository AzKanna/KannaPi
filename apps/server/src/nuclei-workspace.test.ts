import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@kanna/shared";
import { afterEach, describe, expect, test } from "vitest";
import {
  NucleiWorkspaceService,
  nucleiArgs,
  parseNucleiFinding,
  validateNucleiTarget,
} from "./nuclei-workspace.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function store() {
  const path = await mkdtemp(join(tmpdir(), "kanna-nuclei-test-"));
  folders.push(path);
  return join(path, "runs.json");
}
const project: Project = {
  id: "prj_test",
  name: "Test",
  workspacePath: process.cwd(),
  createdAt: 1,
  updatedAt: 1,
};
const input = {
  target: "https://example.test/",
  severity: ["high"] as Array<"high">,
  rateLimit: 5,
  authorized: true,
};

describe("Nuclei workspace", () => {
  test("accepts only one credential-free HTTP URL", () => {
    expect(validateNucleiTarget("https://example.test/path")).toBe("https://example.test/path");
    for (const target of [
      "file:///etc/passwd",
      "https://user:pass@example.test/",
      "https://example.test/#part",
      "https://example.test/?token=secret",
      "https://a.test/\nhttps://b.test/",
    ])
      expect(() => validateNucleiTarget(target)).toThrow();
  });

  test("builds fixed arguments and parses bounded findings", () => {
    expect(nucleiArgs("https://example.test/", ["high"], 5)).toContain("-pt");
    expect(nucleiArgs("https://example.test/", ["high"], 5)).toContain("-no-stdin");
    const finding = parseNucleiFinding(
      JSON.stringify({
        "template-id": "test-id",
        "matched-at": "https://example.test/",
        info: { name: "Test finding", severity: "high" },
      }),
    );
    expect(finding).toMatchObject({ templateId: "test-id", severity: "high", name: "Test finding" });
    expect(parseNucleiFinding("not json")).toBeUndefined();
  });

  test("requires authorization before invoking scanner", async () => {
    const service = new NucleiWorkspaceService(await store(), "missing-nuclei-test-binary");
    await expect(service.start(project, { ...input, authorized: false })).rejects.toThrow("authorized");
    await expect(service.start(project, { ...input, rateLimit: 100 })).rejects.toThrow("Rate limit");
    await service.close();
  });

  test("streams a fake CLI finding and persists a completed run", async () => {
    const path = await store();
    const fake = `if (process.argv.includes('-version')) { console.log('nuclei test'); process.exit(0) } console.log(JSON.stringify({'template-id':'demo-check','matched-at':'https://example.test/','info':{'name':'Demo check','severity':'high'}}))`;
    const service = new NucleiWorkspaceService(path, process.execPath, ["-e", fake, "--"]);
    const started = await service.start(project, input);
    expect(started.status).toBe("running");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake scan timed out")), 5_000);
      const poll = setInterval(() => {
        if (service.list(project.id)[0]?.status !== "running") {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 20);
    });
    expect(service.list(project.id)[0]).toMatchObject({
      status: "completed",
      findings: [{ templateId: "demo-check" }],
    });
    await service.close();
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<{ status: string }>;
    expect(persisted[0]?.status).toBe("completed");
    const restored = new NucleiWorkspaceService(path);
    await restored.load();
    expect(restored.list(project.id)[0]?.findings).toHaveLength(1);
  });

  test("stops a running process and records the stopped state", async () => {
    const path = await store();
    const fake = `if (process.argv.includes('-version')) { process.exit(0) } setInterval(() => {}, 1000)`;
    const service = new NucleiWorkspaceService(path, process.execPath, ["-e", fake, "--"]);
    const run = await service.start(project, input);
    await expect(service.start(project, input)).rejects.toThrow("already running");
    expect((await service.stop(run.id, project.id)).status).toBe("stopped");
    await service.close();
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<{ status: string }>;
    expect(persisted[0]?.status).toBe("stopped");
  });

  test("close waits for child exit and final persistence before allowing directory cleanup", async () => {
    const path = await store();
    const fake = `if (process.argv.includes('-version')) { process.exit(0) } setInterval(() => {}, 1000)`;
    const service = new NucleiWorkspaceService(path, process.execPath, ["-e", fake, "--"]);
    await service.start(project, input);
    await service.close();
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<{
      status: string;
      finishedAt?: number;
    }>;
    expect(persisted[0]?.status).toBe("stopped");
    expect(persisted[0]?.finishedAt).toBeTypeOf("number");
    // A second close is safe and must not race with a late process-close callback.
    await service.close();
    expect(JSON.parse(await readFile(path, "utf8"))[0]?.status).toBe("stopped");
  });
});
