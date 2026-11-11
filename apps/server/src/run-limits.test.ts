import { describe, expect, test } from "vitest";
import { RunLimits } from "./main.js";

describe("RunLimits", () => {
  test("tracks turns, tokens and cost and reports the first exceeded budget", () => {
    const limits = new RunLimits(
      { maxTurns: 2, maxTokens: 100, maxCostUsd: 0.2, maxDurationMs: 10_000 },
      1_000,
    );
    expect(
      limits.observe(
        { type: "turn_end", message: { usage: { input: 40, output: 10, cost: { total: 0.05 } } } },
        1_100,
      ),
    ).toBeUndefined();
    expect(
      limits.observe(
        { type: "turn_end", message: { usage: { input: 40, output: 20, cost: { total: 0.1 } } } },
        1_200,
      ),
    ).toMatch(/token/i);
    expect(limits.snapshot()).toMatchObject({ turns: 2, tokens: 110, costUsd: 0.15 });
  });
});
