#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, SessionsRepo } from "@kanna/database";
import { Command } from "commander";
import { loadReport, runScan, startPlatform } from "./main.js";

interface ModelOptions {
  dataDir: string;
  models: string;
  auth?: string;
  provider: string;
  model: string;
  apiKey?: string;
}
interface PlatformCliOptions {
  dataDir: string;
  models?: string;
  auth?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  host: string;
  port: string;
}
function resolveApiKey(options: ModelOptions): string {
  const value = options.apiKey ?? process.env.KANNA_API_KEY;
  if (!value) throw new Error("API key required: pass --api-key or set KANNA_API_KEY");
  return value;
}

export function createCli(): Command {
  const cli = new Command()
    .name("kanna")
    .description("KannaPi local project and general Agent workspace")
    .version("0.1.0");
  const addModelOptions = (command: Command) =>
    command
      .option("--data-dir <path>", "application data directory", "data")
      .requiredOption("--models <path>", "Pi models.json path")
      .option("--auth <path>", "Pi auth.json path")
      .requiredOption("--provider <id>", "model provider id")
      .requiredOption("--model <id>", "model id")
      .option("--api-key <key>", "API key (prefer KANNA_API_KEY env)");
  cli
    .command("serve")
    .description("start the persistent project and Agent workspace API")
    .option("--data-dir <path>", "application data directory", "data")
    .option("--models <path>", "Pi models.json path; configurable later in the Web UI")
    .option("--auth <path>", "Pi auth.json path")
    .option("--provider <id>", "initial model provider id")
    .option("--model <id>", "initial model id")
    .option("--api-key <key>", "runtime-only API key (prefer configuring in the Web UI)")
    .option("--host <host>", "listen host", "127.0.0.1")
    .option("--port <number>", "listen port", "8081")
    .action(async (options: PlatformCliOptions) => {
      const platform = await startPlatform({
        repoRoot: process.cwd(),
        dataDir: options.dataDir,
        modelsPath: options.models,
        authPath: options.auth,
        providerId: options.provider,
        modelId: options.model,
        apiKey: options.apiKey ?? process.env.KANNA_API_KEY,
        host: options.host,
        port: Number(options.port),
      });
      process.stdout.write(`KannaPi Agent workspace listening on http://${options.host}:${platform.port}\n`);
      const close = async () => {
        await platform.close();
        process.exitCode = 0;
      };
      process.once("SIGINT", () => void close());
      process.once("SIGTERM", () => void close());
    });
  addModelOptions(
    cli
      .command("scan <url>")
      .description("start a new authorized scan")
      .requiredOption("--scope <file>", "scope JSON file")
      .option("--proxy-port <number>", "mitmproxy listen port", "8080")
      .option("--server-port <number>", "REST/WS listen port", "8081"),
  ).action(
    async (url: string, options: ModelOptions & { scope: string; proxyPort: string; serverPort: string }) => {
      const summary = await runScan({
        target: url,
        scopePath: options.scope,
        dataDir: options.dataDir,
        modelsPath: options.models,
        authPath: options.auth,
        providerId: options.provider,
        modelId: options.model,
        apiKey: resolveApiKey(options),
        proxyPort: Number(options.proxyPort),
        serverPort: Number(options.serverPort),
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    },
  );
  addModelOptions(cli.command("resume").description("resume the most recent scan session")).action(
    async (options: ModelOptions) => {
      const db = openDatabase(resolve(options.dataDir, "kanna.db"));
      const latest = new SessionsRepo(db).list()[0];
      db.close();
      if (!latest?.target) throw new Error("No resumable scan session found");
      const summary = await runScan({
        target: latest.target,
        scope: latest.scope,
        dataDir: options.dataDir,
        modelsPath: options.models,
        authPath: options.auth,
        providerId: options.provider,
        modelId: options.model,
        apiKey: resolveApiKey(options),
        resume: true,
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    },
  );
  cli
    .command("report [sessionId]")
    .description("print persisted findings as JSON")
    .option("--data-dir <path>", "application data directory", "data")
    .action((sessionId: string | undefined, options: { dataDir: string }) => {
      process.stdout.write(`${JSON.stringify(loadReport(options.dataDir, sessionId), null, 2)}\n`);
    });
  return cli;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  createCli()
    .parseAsync()
    .catch((error) => {
      process.stderr.write(`kanna: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
