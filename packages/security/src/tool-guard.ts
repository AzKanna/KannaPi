import type { Scope } from "@kanna/shared";
import { urlInScope } from "@kanna/shared";
import type { ApprovalManager } from "./approval.js";
import type { AuditLogger } from "./audit-logger.js";
import type { PolicyEngine, ToolPolicy } from "./policy.js";
import type { RateLimiter } from "./rate-limiter.js";

export interface ToolGuardOptions {
  scope: Scope;
  policy: PolicyEngine;
  rateLimiter: RateLimiter;
  approvals: ApprovalManager;
  audit: AuditLogger;
}

export class ToolGuard {
  constructor(private readonly options: ToolGuardOptions) {}

  async invoke<T>(toolName: string, params: Record<string, unknown>, execute: () => Promise<T>): Promise<T> {
    const target = this.targetUrl(params);
    if (target) {
      const check = urlInScope(this.options.scope, target);
      if (!check.ok) {
        const message = `Scope denied: ${check.reason}`;
        await this.deny(toolName, message, params);
        throw new Error(message);
      }
    }

    let policy: ToolPolicy;
    try {
      policy = this.options.policy.get(toolName, params);
    } catch (error) {
      await this.deny(toolName, (error as Error).message, params);
      throw error;
    }
    if (!target && policy.requiresTarget) {
      const message = "Scope check requires a target URL";
      await this.deny(toolName, message, params);
      throw new Error(message);
    }
    if (target) {
      try {
        this.options.rateLimiter.consume(new URL(target).hostname, this.options.scope.maxRequestsPerSecond);
      } catch (error) {
        await this.deny(toolName, (error as Error).message, params, "rate_limit");
        throw error;
      }
    }

    if (policy.tier >= 2) {
      if (!this.options.scope.activeTesting) {
        if (policy.tier === 3) {
          const message = "Active testing is disabled by scope";
          await this.deny(toolName, message, params);
          throw new Error(message);
        }
      }
      await this.options.audit.log({
        actor: "tool",
        eventType: "approval_request",
        toolName,
        details: params,
      });
      const approval =
        policy.tier === 2
          ? await this.options.approvals.requestOnce(toolName, `Approve ${toolName} for this session`, params)
          : await this.options.approvals.request(`Approve ${toolName}`, params);
      await this.options.audit.log({
        actor: "human",
        eventType: "approval_result",
        toolName,
        decision: approval.decision === "approved" ? "allow" : "deny",
        reason: approval.decision,
        details: { approvalId: approval.id },
      });
      if (approval.decision !== "approved") throw new Error(`Approval ${approval.decision}`);
    }

    await this.options.audit.log({
      actor: "tool",
      eventType: "policy_decision",
      toolName,
      decision: "allow",
      details: params,
    });
    try {
      const result = await execute();
      await this.options.audit.log({ actor: "tool", eventType: "tool_call", toolName, decision: "allow" });
      return result;
    } catch (error) {
      await this.options.audit.log({
        actor: "tool",
        eventType: "tool_call",
        toolName,
        decision: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private targetUrl(params: Record<string, unknown>): string | undefined {
    for (const key of ["url", "targetUrl"]) if (typeof params[key] === "string") return params[key] as string;
    return undefined;
  }

  private async deny(
    toolName: string,
    reason: string,
    details: Record<string, unknown>,
    eventType: "policy_decision" | "rate_limit" = "policy_decision",
  ): Promise<void> {
    await this.options.audit.log({ actor: "tool", eventType, toolName, decision: "deny", reason, details });
  }
}
