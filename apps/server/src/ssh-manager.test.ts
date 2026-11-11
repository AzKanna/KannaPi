import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openDatabase, ProjectsRepo, SshCommandHistoryRepo, SshHostsRepo } from "@kanna/database";
import { Server } from "ssh2";
import { afterEach, describe, expect, test } from "vitest";
import { SshConnectionManager } from "./ssh-manager.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function testSshServer() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    // A deliberate first-use host-key rejection is surfaced as a connection error server-side.
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "tester" && context.password === "secret")
        context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(`ran:${info.command}\n`);
          stream.stderr.write("warning\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("SSH connection manager", () => {
  test("pins the first host key, runs a command, and persists bounded history", async () => {
    const remote = await testSshServer();
    closers.push(remote.close);
    const db = openDatabase(":memory:");
    closers.push(async () => db.close());
    new ProjectsRepo(db).save({
      id: "prj_1",
      name: "SSH test",
      workspacePath: process.cwd(),
      createdAt: 1,
      updatedAt: 1,
    });
    const hosts = new SshHostsRepo(db);
    hosts.save({
      id: "ssh_1",
      projectId: "prj_1",
      name: "Local test server",
      host: "127.0.0.1",
      port: remote.port,
      username: "tester",
      authType: "password",
      createdAt: 1,
      updatedAt: 1,
    });
    const manager = new SshConnectionManager(
      hosts,
      new SshCommandHistoryRepo(db),
      () => undefined,
      () => undefined,
    );
    closers.push(() => manager.close());

    let fingerprint = "";
    await expect(manager.connect("ssh_1", { password: "secret" })).rejects.toThrow(
      /Host key confirmation required/,
    );
    try {
      await manager.connect("ssh_1", { password: "secret" });
    } catch (error) {
      fingerprint = String(error).match(/SHA256:[A-Za-z0-9+/]+/)?.[0] ?? "";
    }
    expect(fingerprint).toMatch(/^SHA256:/);

    const connected = await manager.connect("ssh_1", {
      password: "secret",
      trustFingerprint: fingerprint,
    });
    expect(connected).toMatchObject({ status: "connected", hostFingerprint: fingerprint });
    const result = await manager.execute("ssh_1", "uname -a", { actor: "agent" });
    expect(result).toMatchObject({
      actor: "agent",
      command: "uname -a",
      stdout: "ran:uname -a\n",
      stderr: "warning\n",
      exitCode: 0,
      timedOut: false,
    });
    expect(manager.historyFor("ssh_1")).toEqual([result]);
    expect(manager.disconnect("ssh_1").status).toBe("disconnected");
  });
});
