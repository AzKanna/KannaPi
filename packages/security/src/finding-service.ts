import type { Finding } from "@kanna/shared";
import { newId } from "@kanna/shared";

export interface FindingWriter {
  save(sessionId: string, finding: Finding): void;
}
export type FindingInput = Omit<Finding, "id" | "createdAt" | "updatedAt">;

export class FindingService {
  private readonly byKey = new Map<string, Finding>();
  constructor(private readonly writer: FindingWriter) {}

  report(sessionId: string, input: FindingInput): Finding {
    const evidenceIds = [...new Set([...input.evidence.flowIds, ...input.requestIds])];
    if (evidenceIds.length === 0) throw new Error("Finding requires evidence flow IDs");
    if (
      input.status === "confirmed" &&
      (input.evidence.flowIds.length === 0 || input.requestIds.length === 0)
    )
      throw new Error("Confirmed finding requires evidence and request IDs");
    const key = [
      sessionId,
      input.category,
      input.endpoint?.host ?? "",
      input.endpoint?.method ?? "",
      input.endpoint?.pathTemplate ?? "",
      input.parameter ?? "",
    ].join("\0");
    const existing = this.byKey.get(key);
    const now = Date.now();
    const finding: Finding = {
      ...input,
      id: existing?.id ?? newId("fnd"),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byKey.set(key, finding);
    this.writer.save(sessionId, finding);
    return finding;
  }
}
