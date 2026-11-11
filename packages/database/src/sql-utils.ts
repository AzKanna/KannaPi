/** Small casting helpers for node:sqlite rows (SQLValue union → TS). */
export function asStr(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}
export function asNum(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
export function asJson<T>(v: unknown): T | undefined {
  if (v == null || typeof v !== "string") return undefined;
  return JSON.parse(v) as T;
}
export function asJsonOr<T>(v: unknown, fallback: T): T {
  if (v == null || typeof v !== "string") return fallback;
  return JSON.parse(v) as T;
}
