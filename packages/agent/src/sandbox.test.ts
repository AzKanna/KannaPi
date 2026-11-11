import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createSandboxTools, WindowsSandbox } from "./sandbox.js";

describe.skipIf(process.platform !== "win32")("Windows AppContainer", () => {
  test("isolates commands/files, strips host secrets, blocks network and kills timed-out tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kanna-sandbox-"));
    const source = join(directory, "project");
    await mkdir(source);
    await writeFile(join(source, "note.txt"), "original");
    await writeFile(join(source, ".env"), "SKIP_SECRET=yes");
    const secret = join(directory, "host-secret.txt");
    await writeFile(secret, "host-only");
    const sandbox = new WindowsSandbox(join(directory, "data"), "session-test", source, false);
    process.env.KANNA_SANDBOX_TEST_SECRET = "must-not-inherit";
    try {
      await sandbox.initialize();
      expect(await sandbox.run({ op: "read", path: "note.txt" })).toBe("original");
      await sandbox.run({ op: "write", path: "note.txt", content: "isolated" });
      expect(await readFile(join(source, "note.txt"), "utf8")).toBe("original");
      const attachmentPath = await sandbox.importAttachment("att-test", Buffer.from("input"));
      expect(await sandbox.run({ op: "read", path: attachmentPath })).toBe("input");
      await sandbox.run({ op: "edit", path: "note.txt", oldText: "isolated", newText: "edited" });
      expect(await sandbox.run({ op: "grep", path: "note.txt", pattern: "edited" })).toContain(
        "note.txt:1:edited",
      );
      expect(await sandbox.run({ op: "find", pattern: "*.txt" })).toContain("note.txt");
      expect(await sandbox.run({ op: "ls" })).toContain("note.txt");
      await expect(sandbox.run({ op: "read", path: "../host-secret.txt" })).rejects.toThrow(
        "inside the sandbox",
      );
      await expect(sandbox.run({ op: "read", path: ".env" })).rejects.toThrow();
      const code = `const fs=require('fs');const p=${JSON.stringify(secret)};let read=false,write=false;try{fs.readFileSync(p);read=true}catch{}try{fs.writeFileSync(p,'changed');write=true}catch{}console.log(JSON.stringify({read,write,secret:process.env.KANNA_SANDBOX_TEST_SECRET??null}));`;
      await sandbox.run({ op: "write", path: "probe.cjs", content: code });
      expect(JSON.parse(await sandbox.run({ op: "exec", command: "node probe.cjs" }))).toEqual({
        read: false,
        write: false,
        secret: null,
      });
      expect(await readFile(secret, "utf8")).toBe("host-only");
      await sandbox.run({
        op: "write",
        path: "network.cjs",
        content:
          "const s=require('net').connect({host:'1.1.1.1',port:443});s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',()=>console.log('BLOCKED'));setTimeout(()=>{console.log('BLOCKED');s.destroy()},500);",
      });
      expect(await sandbox.run({ op: "exec", command: "node network.cjs" })).not.toContain("CONNECTED");
      await sandbox.run({ op: "write", path: "slow.cjs", content: "setInterval(()=>{},1000);" });
      await expect(sandbox.run({ op: "exec", command: "node slow.cjs", timeoutSeconds: 1 })).rejects.toThrow(
        "timed out",
      );
      expect(await sandbox.run({ op: "exec", command: "echo still-ready" })).toContain("still-ready");
      expect(createSandboxTools(sandbox, "full").map((tool) => tool.name)).toEqual([
        "read",
        "ls",
        "find",
        "grep",
        "write",
        "edit",
        "sandbox_exec",
      ]);
      const resumed = new WindowsSandbox(join(directory, "data"), "session-test", source, false);
      expect(await resumed.run({ op: "read", path: "note.txt" })).toBe("edited");
      await resumed.dispose();
    } finally {
      delete process.env.KANNA_SANDBOX_TEST_SECRET;
      await sandbox.dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60000);
  test("rejects redirected attachment directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kanna-sandbox-link-"));
    const source = join(directory, "project");
    await mkdir(source);
    const sandbox = new WindowsSandbox(join(directory, "data"), "link-test", source, false);
    try {
      await sandbox.initialize();
      await symlink(source, join(sandbox.workspace, ".inputs"), "junction");
      await expect(sandbox.importAttachment("att-test", Buffer.from("safe"))).rejects.toThrow("link");
    } finally {
      await sandbox.dispose();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60000);
});

test("tool parameters cannot override the operation allowed by a read-only profile", async () => {
  const sandbox = new WindowsSandbox("data", "test", "project", false);
  const run = vi.spyOn(sandbox, "run").mockResolvedValue("test");
  const read = createSandboxTools(sandbox, "read-only").find((tool) => tool.name === "read");
  if (!read) throw new Error("Read tool missing");
  await read.execute(
    "test-call",
    { path: "note.txt", op: "exec", command: "forbidden" },
    undefined,
    undefined,
    undefined,
  );
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ op: "read" }), undefined);
});
