export interface AgentRuntimeSettings {
  sandbox: { enabled: boolean; network: boolean };
  compaction: { enabled: boolean; thresholdPercent: number; keepRecentTokens: number };
  multiAgent: { enabled: boolean; maxConcurrency: number; timeoutMinutes: number };
}
export const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  sandbox: { enabled: true, network: false },
  compaction: { enabled: true, thresholdPercent: 80, keepRecentTokens: 12000 },
  multiAgent: { enabled: true, maxConcurrency: 4, timeoutMinutes: 10 },
};
export interface AgentContextStatus {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  compacting: boolean;
  compactions: number;
  sandboxEnabled: boolean;
  sandboxPath?: string;
  lastCompaction?: { summary: string; tokensBefore: number; timestamp: string };
  error?: string;
}
