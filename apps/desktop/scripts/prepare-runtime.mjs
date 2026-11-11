import { spawnSync } from "node:child_process";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Windows x64 installer must be built with Windows x64 Node.js");
}
if (basename(process.execPath).toLowerCase() !== "node.exe") {
  throw new Error("Run the installer build with standalone Node.js");
}

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(desktopDir, "../../packages/agent/native");
const destination = join(desktopDir, "build", "agent-native");
const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

await mkdir(destination, { recursive: true });
await copyFile(join(sourceDir, "AppContainerRunner.cs"), join(destination, "AppContainerRunner.cs"));
await copyFile(join(sourceDir, "sandbox-worker.mjs"), join(destination, "sandbox-worker.mjs"));
await copyFile(process.execPath, join(destination, "node.exe"));

const helper = join(destination, "AppContainerRunner.exe");
const compilation = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${helper}`, join(sourceDir, "AppContainerRunner.cs")], {
  encoding: "utf8", windowsHide: true,
});
if (compilation.error || compilation.status !== 0) {
  throw new Error(`Could not compile the bundled AppContainer helper: ${compilation.error?.message ?? compilation.stderr ?? compilation.stdout}`);
}
for (const name of ["node.exe", "AppContainerRunner.exe", "sandbox-worker.mjs"]) {
  const file = await stat(join(destination, name));
  if (!file.isFile() || file.size === 0) throw new Error(`Desktop runtime asset is missing: ${name}`);
}
console.log(`Prepared standalone Agent runtime in ${destination}`);
