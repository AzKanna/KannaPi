import { readFile } from "node:fs/promises";
import { type AgentRuntimeSettings, DEFAULT_AGENT_RUNTIME_SETTINGS } from "@kanna/shared";
import { writePrivateJsonFile } from "./private-json-file.js";

export class RuntimeSettingsStore {
  private value: AgentRuntimeSettings = structuredClone(DEFAULT_AGENT_RUNTIME_SETTINGS);
  constructor(private path: string) {}
  get(): AgentRuntimeSettings {
    return structuredClone(this.value);
  }
  async load(): Promise<void> {
    try {
      this.value = this.validate(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private validate(value: unknown): AgentRuntimeSettings {
    if (!value || typeof value !== "object") throw new Error("Invalid runtime settings");
    const row = value as AgentRuntimeSettings;
    if (
      typeof row.sandbox?.enabled !== "boolean" ||
      typeof row.sandbox?.network !== "boolean" ||
      typeof row.compaction?.enabled !== "boolean"
    )
      throw new Error("Sandbox and compression switches must be booleans");
    if (
      !Number.isInteger(row.compaction.thresholdPercent) ||
      row.compaction.thresholdPercent < 50 ||
      row.compaction.thresholdPercent > 95
    )
      throw new Error("Compression threshold must be 50–95%");
    if (
      !Number.isInteger(row.compaction.keepRecentTokens) ||
      row.compaction.keepRecentTokens < 256 ||
      row.compaction.keepRecentTokens > 64000
    )
      throw new Error("Keep recent tokens must be 256–64,000");
    const multiAgent = row.multiAgent ?? DEFAULT_AGENT_RUNTIME_SETTINGS.multiAgent;
    if (typeof multiAgent.enabled !== "boolean" || !Number.isInteger(multiAgent.maxConcurrency) ||
      multiAgent.maxConcurrency < 1 || multiAgent.maxConcurrency > 4 ||
      !Number.isInteger(multiAgent.timeoutMinutes) || multiAgent.timeoutMinutes < 1 || multiAgent.timeoutMinutes > 30)
      throw new Error("Multi-Agent requires a boolean switch, 1–4 concurrent tasks and a 1–30 minute timeout");
    return {
      sandbox: { enabled: row.sandbox.enabled, network: row.sandbox.network },
      compaction: {
        enabled: row.compaction.enabled,
        thresholdPercent: row.compaction.thresholdPercent,
        keepRecentTokens: row.compaction.keepRecentTokens,
      },
      multiAgent: { ...multiAgent },
    };
  }
  async save(input: unknown): Promise<AgentRuntimeSettings> {
    const next = this.validate(input);
    await writePrivateJsonFile(this.path, next);
    this.value = next;
    return this.get();
  }
}
