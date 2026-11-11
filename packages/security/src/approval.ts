import { createInterface } from "node:readline/promises";
import type { Approval } from "@kanna/shared";
import { newId } from "@kanna/shared";

export type ApprovalDecision = "approved" | "denied" | "timeout";
export type ApprovalBackend = (approval: Approval) => Promise<ApprovalDecision>;

export class ApprovalManager {
  private readonly sessionApprovals = new Set<string>();
  constructor(
    private readonly backend: ApprovalBackend,
    private readonly timeoutMs = 60_000,
  ) {}

  async request(summary: string, payload: Record<string, unknown>): Promise<Approval> {
    const approval: Approval = { id: newId("apr"), requestedAt: Date.now(), summary, payload };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ApprovalDecision>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });
    try {
      approval.decision = await Promise.race([this.backend(approval), timeout]);
    } catch {
      approval.decision = "denied";
    } finally {
      if (timer) clearTimeout(timer);
    }
    approval.decidedAt = Date.now();
    if (approval.decision === "approved") approval.decidedBy = "human";
    return approval;
  }

  async requestOnce(key: string, summary: string, payload: Record<string, unknown>): Promise<Approval> {
    if (this.sessionApprovals.has(key)) {
      return {
        id: newId("apr"),
        requestedAt: Date.now(),
        decidedAt: Date.now(),
        summary,
        payload,
        decision: "approved",
        decidedBy: "human",
      };
    }
    const approval = await this.request(summary, payload);
    if (approval.decision === "approved") this.sessionApprovals.add(key);
    return approval;
  }
}

export const cliApprovalBackend: ApprovalBackend = async (approval) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "denied";
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `\nApproval required: ${approval.summary}\nPayload: ${JSON.stringify(approval.payload)}\nAllow? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim()) ? "approved" : "denied";
  } finally {
    prompt.close();
  }
};
