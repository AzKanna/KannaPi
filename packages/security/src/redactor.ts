const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|client[_-]?secret)$/i;
const INLINE_SECRET = /\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;"']+/gi;

export class SecretRedactor {
  redact<T>(value: T): T {
    return this.walk(value, undefined) as T;
  }

  private walk(value: unknown, key: string | undefined): unknown {
    if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (typeof value === "string") {
      if (/^(bearer|basic)\s+/i.test(value)) return "[REDACTED]";
      return value.replace(INLINE_SECRET, (_match, name: string) => `${name}=[REDACTED]`);
    }
    if (Array.isArray(value)) return value.map((item) => this.walk(item, undefined));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.walk(v, k)]));
    return value;
  }
}
