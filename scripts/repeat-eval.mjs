import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
const runsIndex = process.argv.indexOf("--runs");
const runs = runsIndex >= 0 ? Number(process.argv[runsIndex + 1]) : 3;
const command = separator >= 0 ? process.argv[separator + 1] : undefined;
const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
if (!command || !Number.isInteger(runs) || runs < 1)
  throw new Error("Usage: node scripts/repeat-eval.mjs --runs 3 -- <command> [args...]");

function execute() {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { shell: false, windowsHide: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve({ durationMs: performance.now() - startedAt, stdout })
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`)),
    );
  });
}
const results = [];
for (let i = 0; i < runs; i++) results.push(await execute());
const durations = results.map((r) => r.durationMs);
const mean = durations.reduce((a, b) => a + b, 0) / runs;
const stddev = Math.sqrt(durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / runs);
console.log(
  JSON.stringify(
    {
      runs,
      durationMs: { mean, stddev, min: Math.min(...durations), max: Math.max(...durations) },
      samples: results,
    },
    null,
    2,
  ),
);
