export interface RunLimitConfig {
  maxTurns: number;
  maxTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
}
export interface RunUsage {
  turns: number;
  tokens: number;
  costUsd: number;
  elapsedMs: number;
  violation?: string;
}

function numberAt(value: unknown, keys: string[]): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "number") return record[key] as number;
  return 0;
}

export class RunLimits {
  private turns = 0;
  private tokens = 0;
  private costUsd = 0;
  private violation?: string;
  constructor(
    readonly config: RunLimitConfig,
    private readonly startedAt = Date.now(),
  ) {}

  observe(event: unknown, now = Date.now()): string | undefined {
    if (!event || typeof event !== "object") return this.check(now);
    const record = event as Record<string, unknown>;
    if (record.type === "turn_end") {
      this.turns++;
      const message =
        record.message && typeof record.message === "object"
          ? (record.message as Record<string, unknown>)
          : record;
      const usage =
        message.usage && typeof message.usage === "object" ? (message.usage as Record<string, unknown>) : {};
      this.tokens +=
        numberAt(usage, ["input", "inputTokens", "prompt_tokens", "promptTokens"]) +
        numberAt(usage, ["output", "outputTokens", "completion_tokens", "completionTokens"]);
      const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : usage;
      this.costUsd += numberAt(cost, ["total", "totalUsd", "costUsd"]);
    }
    return this.check(now);
  }

  snapshot(now = Date.now()): RunUsage {
    return {
      turns: this.turns,
      tokens: this.tokens,
      costUsd: Number(this.costUsd.toFixed(8)),
      elapsedMs: now - this.startedAt,
      violation: this.violation,
    };
  }

  private check(now: number): string | undefined {
    this.violation ??=
      this.turns > this.config.maxTurns
        ? `Turn limit exceeded (${this.turns}/${this.config.maxTurns})`
        : this.tokens > this.config.maxTokens
          ? `Token limit exceeded (${this.tokens}/${this.config.maxTokens})`
          : this.costUsd > this.config.maxCostUsd
            ? `Cost limit exceeded ($${this.costUsd.toFixed(4)}/$${this.config.maxCostUsd})`
            : now - this.startedAt > this.config.maxDurationMs
              ? `Duration limit exceeded (${now - this.startedAt}/${this.config.maxDurationMs}ms)`
              : undefined;
    return this.violation;
  }
}
