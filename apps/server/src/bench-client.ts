import { isIP } from "node:net";
import type { BenchChallenge, BenchStartResult, BenchSubmitResult } from "@kanna/shared";

// Verified against the published tsec-benchmark 0.1.2 client.py, not guessed routes.
export const BENCH_SDK_VERSION = "tsec-benchmark 0.1.2 protocol";
const PATH = "/openapi/v1/challenges";
export class BenchError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function benchRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchError("bad_response", "Bench returned an invalid object");
  return value as Record<string, unknown>;
}
export function benchString(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new BenchError("validation", `Invalid ${field}`);
  return value;
}
export function benchCode(value: unknown): string {
  const code = benchString(value, 200, "challenge code");
  if (!code.trim() || /[\r\n]/.test(code)) throw new BenchError("validation", "Invalid challenge code");
  return code;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new BenchError("bad_response", `Invalid Bench ${field}`);
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BenchError("bad_response", "Invalid Bench boolean");
  return value;
}
export function benchBaseUrl(value: unknown): string {
  const raw = benchString(value, 2000, "Bench Base URL").trim();
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new BenchError("validation", "Bench Base URL must be an HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new BenchError("validation", "Bench Base URL cannot contain credentials, query parameters or fragments");
  return url.href.replace(/\/+$/, "");
}
export function benchToken(value: unknown): string {
  const token = benchString(value, 4096, "Benchmark Token").trim();
  if (/[^\x21-\x7e]/.test(token)) throw new BenchError("validation", "Benchmark Token must contain printable ASCII only");
  return token;
}
function addresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new BenchError("bad_response", "Invalid Bench container addresses");
  return value.map((item) => {
    const address = benchString(item, 100, "container address");
    const match = address.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/);
    if (!match || !isIP(match[1] ?? match[2] ?? "") || Number(match[3]) < 1 || Number(match[3]) > 65535)
      throw new BenchError("bad_response", "Bench container address must be IP:port (IPv6 in brackets)");
    return address;
  });
}
function challenge(value: unknown): BenchChallenge {
  const row = benchRecord(value);
  const status = row.container_status ?? "stopped";
  if (!["stopped", "pending", "available", "stop_pending"].includes(String(status))) throw new BenchError("bad_response", "Invalid Bench container status");
  if (typeof row.level !== "string" && typeof row.level !== "number") throw new BenchError("bad_response", "Invalid Bench level");
  const flags = integer(row.flag_count, "flag count"), correct = integer(row.correct_flag_count, "correct flags");
  if (correct > flags || flags > 1000) throw new BenchError("bad_response", "Invalid Bench flag progress");
  return {
    unique_code: benchCode(row.unique_code), description: row.description == null ? null : benchString(row.description, 100_000, "description"),
    difficulty: benchString(row.difficulty, 100, "difficulty"), level: typeof row.level === "string" ? benchString(row.level, 100, "level") : integer(row.level, "level"),
    total_score: integer(row.total_score, "score"), flag_count: flags, correct_flag_count: correct,
    is_completed: boolean(row.is_completed), container_status: status as BenchChallenge["container_status"], container_addr: addresses(row.container_addr ?? []),
  };
}

export interface BenchClientPort {
  checkVpn(signal?: AbortSignal): Promise<unknown>;
  list(signal?: AbortSignal): Promise<BenchChallenge[]>;
  start(code: string, signal?: AbortSignal): Promise<BenchStartResult>;
  submit(code: string, flag: string, signal?: AbortSignal): Promise<BenchSubmitResult>;
  hint(code: string, signal?: AbortSignal): Promise<string | null>;
  close(code: string): Promise<boolean>;
}
export class BenchClient implements BenchClientPort {
  private vpnChecked = false;
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly vpnUrl = process.env.KANNAPI_BENCH_VPN_URL ?? "",
  ) {}
  async checkVpn(signal?: AbortSignal) {
    this.vpnChecked = false;
    const vpnUrl = benchBaseUrl(this.vpnUrl);
    if (!vpnUrl)
      throw new BenchError("vpn_check_failed", "Set KANNAPI_BENCH_VPN_URL to the authorized VPN health-check URL");
    try {
      // A connectivity probe does not need credentials. Never send task tokens to this HTTP endpoint.
      const row = benchRecord(await this.request(vpnUrl, {}, signal, 10_000));
      if (row.status !== "ok") throw new Error("status_not_ok");
      this.vpnChecked = true;
      return { status: "ok", ok: true, client_ip: typeof row.client_ip === "string" ? row.client_ip.slice(0, 100) : null, time: typeof row.time === "string" ? row.time.slice(0, 100) : null };
    } catch {
      if (signal?.aborted) throw new BenchError("cancelled", "Bench cancelled");
      throw new BenchError("vpn_check_failed", "VPN检测未通过，请检查靶场 VPN 网络配置和探测地址");
    }
  }
  private async api(suffix: string, method: string, code?: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.vpnChecked) throw new BenchError("vpn_check_failed", "Run VPN precheck before using the Bench platform");
    if (!this.baseUrl || !this.token) throw new BenchError("configuration", "Configure Benchmark Base URL and Token first");
    const url = new URL(`${this.baseUrl}${PATH}${suffix}`);
    if (code) url.searchParams.set("unique_code", benchCode(code));
    return this.request(url.href, { method, headers: { BENCHMARK_TOKEN: this.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, signal);
  }
  async list(signal?: AbortSignal): Promise<BenchChallenge[]> {
    const rows = await this.api("", "GET", undefined, undefined, signal);
    if (!Array.isArray(rows) || rows.length > 1000) throw new BenchError("bad_response", "Invalid Bench challenge list");
    const result = rows.map(challenge);
    if (new Set(result.map((item) => item.unique_code)).size !== result.length) throw new BenchError("bad_response", "Duplicate Bench challenge codes");
    return result;
  }
  async start(code: string, signal?: AbortSignal): Promise<BenchStartResult> {
    const row = benchRecord(await this.api("/start", "POST", code, undefined, signal));
    if (row.unique_code !== code) throw new BenchError("bad_response", "Bench start returned another challenge");
    return { unique_code: code, container_addr: addresses(row.container_addr) };
  }
  async submit(code: string, flag: string, signal?: AbortSignal): Promise<BenchSubmitResult> {
    const row = benchRecord(await this.api("/submit", "POST", undefined, { unique_code: benchCode(code), flag: benchString(flag, 4096, "flag") }, signal));
    const total = integer(row.total_flag_count, "total flags"), correct = integer(row.correct_flag_count, "correct flags");
    if (correct > total) throw new BenchError("bad_response", "Invalid Bench submission progress");
    return { correct: boolean(row.correct), awarded: integer(row.awarded, "awarded score"), cumulative_score: integer(row.cumulative_score, "cumulative score"), correct_flag_count: correct, total_flag_count: total, matched_flag_index: row.matched_flag_index == null ? null : integer(row.matched_flag_index, "flag index") };
  }
  async hint(code: string, signal?: AbortSignal): Promise<string | null> {
    const row = benchRecord(await this.api("/hint", "GET", code, undefined, signal));
    if (row.unique_code !== code) throw new BenchError("bad_response", "Bench hint returned another challenge");
    return row.hint == null ? null : benchString(row.hint, 20_000, "hint");
  }
  async close(code: string): Promise<boolean> {
    // Cleanup intentionally does not inherit the solve/Stop cancellation signal.
    const row = benchRecord(await this.api("/close", "POST", code));
    if (row.unique_code !== code) throw new BenchError("bad_response", "Bench close returned another challenge");
    return boolean(row.closed ?? true);
  }
  private async request(url: string, init: RequestInit, signal?: AbortSignal, timeout = 30_000): Promise<unknown> {
    const combined = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: "error", signal: combined }); }
    catch { throw new BenchError(signal?.aborted ? "cancelled" : "connection", "Bench request timed out or could not connect; verify VPN and platform address"); }
    const reader = response.body?.getReader();
    if (!reader) throw new BenchError("bad_response", "Bench returned an empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    let value: unknown;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) throw new BenchError("bad_response", "Bench response exceeded 2 MB");
        chunks.push(chunk.value);
      }
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new BenchError("bad_response", "Bench returned invalid JSON"); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (!response.ok) {
      const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const code = typeof row.code === "string" && ["task_not_found", "challenge_not_found", "invalid_state", "duplicate", "resource_unavailable", "internal_error"].includes(row.code) ? row.code : `http_${response.status}`;
      const descriptions: Record<string, string> = { task_not_found: "Token 无效或任务不存在", challenge_not_found: "题目不属于当前任务", invalid_state: "任务已结束、题目状态不允许或活跃容器达到上限；请在平台检查", duplicate: "该 Flag 已正确提交过", resource_unavailable: "靶场资源暂不可用", internal_error: "平台内部错误" };
      // Never reflect arbitrary platform error messages or transport exceptions (may contain tokens).
      throw new BenchError(code, descriptions[code] ?? `Bench failed (HTTP ${response.status})`);
    }
    return value;
  }
}
