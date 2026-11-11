import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolProfile } from "@kanna/shared";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const nativeDir =
  resourcesPath && existsSync(join(resourcesPath, "agent-native"))
    ? join(resourcesPath, "agent-native")
    : fileURLToPath(new URL("../native/", import.meta.url));
const compiler = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);
const compiling = new Map<string, Promise<string>>();

async function nodeBinary(): Promise<string> {
  const bundled = join(nativeDir, "node.exe");
  if (existsSync(bundled)) return bundled;
  if (basename(process.execPath).toLowerCase() === "node.exe") return process.execPath;
  const found = await execFileAsync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
    ["node.exe"],
    { windowsHide: true, timeout: 5000 },
  );
  const path = found.stdout.trim().split(/\r?\n/)[0];
  if (!path || !isAbsolute(path)) throw new Error("Install Node.js to use the Windows sandbox");
  return path;
}

export async function sandboxAvailability(): Promise<{ available: boolean; detail: string }> {
  try {
    if (process.platform !== "win32") throw new Error("This sandbox backend requires Windows 10/11");
    if (!existsSync(join(nativeDir, "AppContainerRunner.exe"))) await access(compiler, constants.R_OK);
    await nodeBinary();
    return { available: true, detail: "Windows AppContainer · Node.js · no Docker/WSL required" };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function helper(agentDir: string): Promise<string> {
  const bundled = join(nativeDir, "AppContainerRunner.exe");
  if (existsSync(bundled)) return bundled;
  const source = await readFile(join(nativeDir, "AppContainerRunner.cs"));
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const destination = join(agentDir, "native", `AppContainerRunner-${hash}.exe`);
  if (await stat(destination).catch(() => undefined)) return destination;
  if (!compiling.has(destination))
    compiling.set(
      destination,
      (async () => {
        await mkdir(dirname(destination), { recursive: true });
        const stagedSource = join(dirname(destination), `AppContainerRunner-${hash}.cs`);
        await writeFile(stagedSource, source, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        await execFileAsync(compiler, ["/nologo", `/out:${destination}`, stagedSource], {
          windowsHide: true,
          timeout: 30000,
        });
        return destination;
      })().finally(() => {
        compiling.delete(destination);
      }),
    );
  await compiling.get(destination);
  return destination;
}

const OMIT =
  /^(?:node_modules|\.git|\.venv|\.ssh|\.aws|\.azure|\.gnupg|\.pi|data|dist|release|\.tmp|\.runtime|\.inputs|\.home|\.env(?:\..*)?|auth\.json|models\.json|settings\.json)$|\.(?:pem|key|pfx|p12)$/i;
export async function copySandboxSnapshot(
  source: string,
  destination: string,
  excludedRoot: string,
): Promise<void> {
  let total = 0,
    count = 0;
  async function copy(from: string, to: string, depth: number): Promise<void> {
    if (depth > 30) return;
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || OMIT.test(entry.name)) continue;
      const path = join(from, entry.name);
      if (resolve(path) === resolve(excludedRoot)) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) continue;
      const target = join(to, entry.name);
      if (entry.isDirectory()) {
        await mkdir(target, { recursive: true });
        await copy(path, target, depth + 1);
      } else if (entry.isFile()) {
        total += metadata.size;
        count++;
        if (total > 100 * 1024 * 1024 || count > 10000)
          throw new Error(
            "Sandbox snapshot exceeds 100 MB / 10,000 files. Select a smaller Session workspace.",
          );
        await copyFile(path, target, constants.COPYFILE_EXCL);
      }
    }
  }
  await copy(source, destination, 0);
}

export class WindowsSandbox {
  private running = new Set<ReturnType<typeof spawn>>();
  private ready?: Promise<void>;
  readonly workspace: string;
  readonly profile: string;
  constructor(
    private agentDir: string,
    sessionId: string,
    private source: string,
    private network: boolean,
    private skills: string[] = [],
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid sandbox session ID");
    this.workspace = join(agentDir, "sandboxes", sessionId, "workspace");
    this.profile = `kannapi.${createHash("sha256").update(resolve(this.workspace)).digest("hex").slice(0, 24)}`;
  }
  get skillPaths(): string[] {
    return this.skills.map((_path, index) => join(this.workspace, ".skills", String(index)));
  }
  async initialize(): Promise<void> {
    if (!this.ready)
      this.ready = this.prepare().catch((error) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
  private async prepare(): Promise<void> {
    const availability = await sandboxAvailability();
    if (!availability.available)
      throw new Error(`Sandbox unavailable: ${availability.detail}. No host fallback was executed.`);
    await helper(this.agentDir);
    const parent = dirname(this.workspace);
    await mkdir(parent, { recursive: true });
    const marker = join(parent, "snapshot.json");
    if (!(await stat(marker).catch(() => undefined))) {
      if (await stat(this.workspace).catch(() => undefined))
        throw new Error("Incomplete sandbox snapshot. Use a new Session.");
      await mkdir(this.workspace);
      await copySandboxSnapshot(this.source, this.workspace, this.agentDir);
      if (this.skills.length) {
        await this.safeDirectory(".skills");
        for (const [index, skill] of this.skills.entries()) {
          const directory = join(this.workspace, ".skills", String(index));
          await mkdir(directory);
          const metadata = await lstat(skill);
          if (metadata.isSymbolicLink()) throw new Error("Sandbox Skill path cannot be a link");
          await copySandboxSnapshot(
            metadata.isDirectory() ? skill : dirname(skill),
            directory,
            this.agentDir,
          );
        }
      }
      await this.safeDirectory(".runtime");
      await copyFile(
        await nodeBinary(),
        join(this.workspace, ".runtime", "node.exe"),
        constants.COPYFILE_EXCL,
      );
      await copyFile(
        join(nativeDir, "sandbox-worker.mjs"),
        join(this.workspace, ".runtime", "worker.mjs"),
        constants.COPYFILE_EXCL,
      );
      const probe = await this.executeCommand("echo AppContainer-ready", undefined, 15000, true);
      if (!probe.includes("AppContainer-ready")) throw new Error("Sandbox health check failed");
      await writeFile(
        marker,
        JSON.stringify({ source: this.source, skills: this.skills, createdAt: Date.now() }),
        { flag: "wx" },
      );
    } else {
      const snapshot = JSON.parse(await readFile(marker, "utf8")) as { source: string; skills?: string[] };
      if (resolve(snapshot.source) !== resolve(this.source))
        throw new Error("Session workspace changed. Create a new Session for a fresh sandbox snapshot.");
      if (JSON.stringify(snapshot.skills ?? []) !== JSON.stringify(this.skills))
        throw new Error("Sandbox Skills changed. Create a new Session to apply the updated Skill snapshot.");
    }
    await this.safeDirectory(".runtime");
  }
  private async safeDirectory(name: string): Promise<string> {
    const root = await realpath(this.workspace);
    if ((await lstat(this.workspace)).isSymbolicLink()) throw new Error("Sandbox workspace cannot be a link");
    const path = join(this.workspace, name);
    const metadata = await lstat(path).catch(() => undefined);
    if (metadata?.isSymbolicLink()) throw new Error("Sandbox storage cannot be a link");
    await mkdir(path, { recursive: true });
    const child = relative(root, await realpath(path));
    if (child === ".." || child.startsWith("..\\") || isAbsolute(child))
      throw new Error("Invalid sandbox storage path");
    return path;
  }
  async importAttachment(id: string, bytes: Buffer): Promise<string> {
    await this.initialize();
    if (this.running.size) throw new Error("Wait for sandbox tools to finish before importing attachments");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid attachment ID");
    const directory = await this.safeDirectory(".inputs");
    const target = join(directory, id);
    if (!(await lstat(target).catch(() => undefined))) await writeFile(target, bytes, { flag: "wx" });
    else if ((await lstat(target)).isSymbolicLink()) throw new Error("Attachment path cannot be a link");
    return `.inputs/${id}`;
  }
  async run(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    await this.initialize();
    const payload = Buffer.from(JSON.stringify(input)).toString("base64");
    return this.executeCommand(
      `".runtime\\node.exe" ".runtime\\worker.mjs" "${payload}"`,
      signal,
      input.op === "exec"
        ? Math.min(120000, Math.max(1000, Number(input.timeoutSeconds ?? 60) * 1000))
        : 30000,
    );
  }
  private async executeCommand(
    command: string,
    signal: AbortSignal | undefined,
    timeout: number,
    initialize = false,
  ): Promise<string> {
    if (signal?.aborted) throw new Error("Sandbox execution aborted");
    const executable = await helper(this.agentDir);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        executable,
        [
          this.profile,
          this.workspace,
          Buffer.from(command, "utf16le").toString("base64"),
          this.network ? "network" : "offline",
          String(timeout),
          initialize ? "init" : "cmd",
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.running.add(child);
      let output = "",
        failure = "";
      const onAbort = () => child.kill();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => child.kill(), timeout + 5000);
      child.stdout?.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > 1000000) child.kill();
      });
      child.stderr?.on("data", (chunk) => {
        failure += chunk.toString("utf8");
        if (failure.length > 1000000) child.kill();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.running.delete(child);
        if (signal?.aborted) reject(new Error("Sandbox execution aborted"));
        else if (code !== 0)
          reject(
            new Error(`${failure || output || "Sandbox process failed"} (exit ${code})`.slice(0, 64000)),
          );
        else resolvePromise((output + (failure ? `\n${failure}` : "")).slice(0, 64000));
      });
      child.stdin?.end();
    });
  }
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.running].map(
        (child) =>
          new Promise<void>((resolvePromise) => {
            child.once("close", () => resolvePromise());
            child.kill();
          }),
      ),
    );
    this.running.clear();
  }
}

export function createSandboxTools(sandbox: WindowsSandbox, profile: AgentToolProfile): ToolDefinition[] {
  if (profile === "chat") return [];
  const path = Type.Optional(Type.String({ description: "Relative path inside the isolated workspace" }));
  const tools: ToolDefinition[] = [
    defineTool({
      name: "read",
      label: "Sandbox Read",
      description: "Read a UTF-8 text file inside the sandbox",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number({ minimum: 1 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })),
      }),
      execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "read" }, signal)),
    }),
    defineTool({
      name: "ls",
      label: "Sandbox List",
      description: "List files inside the sandbox",
      parameters: Type.Object({ path }),
      execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "ls" }, signal)),
    }),
    defineTool({
      name: "find",
      label: "Sandbox Find",
      description: "Find sandbox files matching a wildcard pattern",
      parameters: Type.Object({ path, pattern: Type.String() }),
      execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "find" }, signal)),
    }),
    defineTool({
      name: "grep",
      label: "Sandbox Search",
      description: "Search sandbox text files for a literal pattern",
      parameters: Type.Object({ path, pattern: Type.String() }),
      execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "grep" }, signal)),
    }),
  ];
  if (profile === "workspace" || profile === "full")
    tools.push(
      defineTool({
        name: "write",
        label: "Sandbox Write",
        description: "Write a UTF-8 file in the isolated workspace; original project files are not modified",
        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "write" }, signal)),
      }),
      defineTool({
        name: "edit",
        label: "Sandbox Edit",
        description: "Replace exactly one occurrence of oldText in a sandbox file",
        parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
        execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "edit" }, signal)),
      }),
    );
  if (profile === "full")
    tools.push(
      defineTool({
        name: "sandbox_exec",
        label: "Sandbox Command",
        description:
          "Run a Windows cmd.exe command in AppContainer. Node.js (node) and Windows system tools (curl.exe) are available. Use relative paths. PowerShell is not supported in this sandbox. Children inherit restricted access to shared Windows resources and the isolated workspace; host environment credentials are not passed in. Network access depends on Sandbox settings.",
        parameters: Type.Object({
          command: Type.String({ minLength: 1, maxLength: 16000 }),
          path,
          timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
        }),
        execute: async (_id, params, signal) => result(await sandbox.run({ ...params, op: "exec" }, signal)),
      }),
    );
  return tools;
}
function result(text: string) {
  return {
    content: [{ type: "text" as const, text: text || "(no output)" }],
    details: { sandbox: "windows-appcontainer" },
  };
}
