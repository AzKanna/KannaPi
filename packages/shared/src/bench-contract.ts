/** TSec SDK 0.1.2 wire types. Platform field names intentionally remain snake_case. */
import type { AttackGraph } from "./kanna-events.js";

export interface BenchChallenge {
  unique_code: string;
  description: string | null;
  difficulty: string;
  level: string | number;
  total_score: number;
  flag_count: number;
  correct_flag_count: number;
  is_completed: boolean;
  container_status: "pending" | "available" | "stop_pending" | "stopped";
  container_addr: string[];
}
export interface BenchStartResult { unique_code: string; container_addr: string[] }
export interface BenchSubmitResult {
  correct: boolean;
  awarded: number;
  cumulative_score: number;
  correct_flag_count: number;
  total_flag_count: number;
  matched_flag_index: number | null;
}
export interface BenchSettings { baseUrl: string; tokenConfigured: boolean; sdkVersion: string }
export interface BenchRunOptions {
  agentId: string;
  challengeCodes: string[];
  authorized: boolean;
  allowSandboxNetwork: boolean;
  allowHints: boolean;
  minutesPerChallenge: number;
  maxRounds: number;
  maxSubmissions: number;
}
export interface BenchLog { at: number; kind: "status" | "assistant" | "tool" | "submission" | "error"; text: string; challengeCode?: string }
export interface BenchTaskResult {
  code: string;
  sessionId?: string;
  sessionDeleted?: boolean;
  status: "queued" | "starting" | "solving" | "solved" | "incomplete" | "skipped" | "failed" | "stopped";
  addresses: string[];
  correctFlags: number;
  totalFlags: number;
  awarded: number;
  attempts: number;
  hintUsed: boolean;
  closed?: boolean;
  error?: string;
}

export interface BenchSessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  at: number;
  toolName?: string;
  toolCallId?: string;
  phase?: "running" | "completed" | "failed";
}

export interface BenchSessionSummary {
  id: string;
  projectId: string;
  agentId: string;
  runId: string;
  challengeCode: string;
  title?: string;
  status: BenchTaskResult["status"];
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  hasGraph: boolean;
}

export interface BenchSession extends Omit<BenchSessionSummary, "messageCount" | "hasGraph"> {
  messages: BenchSessionMessage[];
  messagesTruncated?: boolean;
  graph?: AttackGraph;
}
export interface BenchRun {
  id: string;
  projectId: string;
  agentId: string;
  model: string;
  baseUrl: string;
  status: "running" | "stopping" | "completed" | "failed" | "stopped" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  options: BenchRunOptions;
  tasks: BenchTaskResult[];
  logs: BenchLog[];
  logsTruncated?: boolean;
  cleanupCode?: string;
  error?: string;
}
