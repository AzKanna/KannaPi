import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TARGET = "http://127.0.0.1:3000";
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function healthy() {
  try {
    return (await fetch(TARGET, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

export async function ensureJuiceShop(options = {}) {
  if (await healthy()) return { url: TARGET, process: undefined, started: false };
  const sourceDir = options.sourceDir ?? process.env.JUICE_SHOP_DIR;
  let child;
  if (sourceDir && existsSync(join(resolve(sourceDir), "package.json"))) {
    child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["start"], {
      cwd: resolve(sourceDir),
      stdio: "inherit",
      windowsHide: true,
    });
  } else {
    child = spawn("docker", ["run", "--rm", "-p", "3000:3000", "bkimminich/juice-shop"], {
      stdio: "inherit",
      windowsHide: true,
    });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Juice Shop exited before becoming ready (${child.exitCode})`);
    if (await healthy()) return { url: TARGET, process: child, started: true };
    await wait(1000);
  }
  child.kill();
  throw new Error("Juice Shop did not become healthy within the timeout");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  ensureJuiceShop()
    .then(({ url, started }) => console.log(JSON.stringify({ url, started })))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
