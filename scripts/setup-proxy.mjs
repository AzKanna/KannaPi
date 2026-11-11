#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Ensures services/proxy/.venv exists with mitmproxy + websockets installed.
 * Called automatically by the server (ProxySupervisor) when needed, or manually:
 *   node scripts/setup-proxy.mjs
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proxyDir = join(root, "services", "proxy");
const isWindows = process.platform === "win32";
const venvPython = join(
  proxyDir,
  ".venv",
  isWindows ? "Scripts" : "bin",
  isWindows ? "python.exe" : "python",
);
const mitmdump = join(proxyDir, ".venv", isWindows ? "Scripts" : "bin", "mitmdump");
const directNetworkEnv = { ...process.env, NO_PROXY: "*", no_proxy: "*" };

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

if (!existsSync(venvPython)) {
  console.log("Creating Python venv for the traffic proxy...");
  run("python", ["-m", "venv", ".venv"], { cwd: proxyDir });
  run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], {
    env: directNetworkEnv,
  });
}

const check = spawnSync(venvPython, ["-c", "import mitmproxy, websockets"], {
  shell: false,
  encoding: "utf8",
});
if (check.status !== 0) {
  console.log("Installing mitmproxy + websockets into the venv...");
  run(venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"], {
    cwd: proxyDir,
    env: directNetworkEnv,
  });
}

console.log(`Proxy venv ready. mitmdump: ${mitmdump}`);
