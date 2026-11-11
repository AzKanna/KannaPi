import { mkdtemp, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PcapWorkspaceService } from "./pcap-workspace.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

function emptyCapture(): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(1, 20);
  return header;
}

describe("PCAP workspace persistence", () => {
  test("imports, lists, and restores a project-scoped report", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-pcap-"));
    folders.push(root);
    const service = new PcapWorkspaceService(root);
    const report = await service.importCapture("proj_test", "capture.pcap", emptyCapture());
    expect(report.id).toMatch(/^pcap-/);
    expect(report.packetCount).toBe(0);
    expect((await service.list("proj_test"))[0]?.id).toBe(report.id);
    expect((await service.list("proj_test"))[0]).not.toHaveProperty("http");
    await unlink(join(root, "proj_test", report.id, "summary.json"));
    expect((await service.list("proj_test"))[0]?.id).toBe(report.id);
    expect((await service.list("proj_test"))[0]).not.toHaveProperty("credentials");
    expect((await new PcapWorkspaceService(root).get("proj_test", report.id)).name).toBe("capture.pcap");
    expect(await readFile(join(root, "proj_test", report.id, "capture.pcap"))).toEqual(emptyCapture());
    expect(report.captureSha256).toBe(createHash("sha256").update(emptyCapture()).digest("hex"));
    expect(await service.readCapture("proj_test", report.id)).toMatchObject({ name: "capture.pcap", bytes: emptyCapture() });
    await expect(service.readCapture("proj_other", report.id)).rejects.toThrow(/not found/i);
    await expect(service.get("proj_other", report.id)).rejects.toThrow(/not found/i);
  });

  test("rejects invalid capture before creating a report and blocks path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-pcap-"));
    folders.push(root);
    const service = new PcapWorkspaceService(root);
    await expect(service.importCapture("proj_test", "capture.pcap", Buffer.from("bad"))).rejects.toThrow();
    expect(await service.list("proj_test")).toEqual([]);
    await expect(service.list("../outside")).rejects.toThrow(/identifier/i);
    await expect(service.readFile("proj_test", "../../outside", "file-1")).rejects.toThrow(/identifier/i);
  });

  test("reanalyzes a saved capture with an in-memory TLS key log without persisting secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-pcap-"));
    folders.push(root);
    const service = new PcapWorkspaceService(root);
    const report = await service.importCapture("proj_test", "capture.pcap", emptyCapture());
    const keyLog = Buffer.from(`CLIENT_TRAFFIC_SECRET_0 ${"11".repeat(32)} ${"22".repeat(32)}\n`);
    const updated = await service.applyTlsKeyLog("proj_test", report.id, keyLog);
    expect(updated.id).toBe(report.id);
    expect(updated.createdAt).toBe(report.createdAt);
    expect(await readdir(join(root, "proj_test", report.id))).toEqual([
      "capture.pcap",
      "report.json",
      "summary.json",
    ]);
    await expect(
      service.applyTlsKeyLog("proj_test", report.id, Buffer.from("not a key log")),
    ).rejects.toThrow(/key log/i);
    expect((await service.get("proj_test", report.id)).id).toBe(report.id);
  });

  test("uses the bundled TShark for imported captures and never retains its temporary key log", async () => {
    const root = await mkdtemp(join(tmpdir(), "kanna-pcap-tshark-"));
    folders.push(root);
    const seenKeyLogs: string[] = [];
    const service = new PcapWorkspaceService(root, {
      executable: "fixture-tshark.exe",
      dissect: async (_executable, _capture, keyLogPath) => {
        if (keyLogPath) {
          seenKeyLogs.push(keyLogPath);
          expect((await readFile(keyLogPath, "utf8"))).toContain("CLIENT_TRAFFIC_SECRET_0");
        }
        return [{ frame: 1, source: "10.0.0.4", target: "10.0.0.9", sourcePort: 51000, targetPort: 80,
          stream: 1, method: "POST", path: "/gateway", host: "lab.local", body: Buffer.from("ant=asoutput()") }];
      },
    });
    const report = await service.importCapture("proj_test", "capture.pcap", emptyCapture());
    expect(report.tshark).toMatchObject({ status: "used", httpRecords: 1 });
    expect(report.webshells[0]?.family).toBe("AntSword");
    const keyLog = Buffer.from(`CLIENT_TRAFFIC_SECRET_0 ${"11".repeat(32)} ${"22".repeat(32)}\n`);
    const updated = await service.applyTlsKeyLog("proj_test", report.id, keyLog);
    expect(updated.tshark).toMatchObject({ status: "used", httpRecords: 1 });
    expect(seenKeyLogs).toHaveLength(1);
    await expect(stat(seenKeyLogs[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
