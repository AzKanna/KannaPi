/**
 * FlowStore — token-budgeted query facade over the flows repo (list/detail
 * separation per ADR-005/006). Redaction is applied by the tool layer (T10)
 * on top of what this returns.
 */
import { OUTPUT_LIMITS, type TrafficFlow, type TrafficFlowSummary } from "@kanna/shared";
import type { FlowFilter } from "./flow-repo-shapes.js";

/** Structural interface satisfied by @kanna/database FlowsRepo. */
export interface FlowReader {
  list(sessionId: string, filter: FlowFilter): { rows: TrafficFlowSummary[]; total: number };
  get(id: string): TrafficFlow | undefined;
  listByAction(actionId: string): TrafficFlow[];
  recent(sessionId: string, sinceTs: number, limit?: number): TrafficFlow[];
  getBodyBytes(hash: string): Uint8Array | undefined;
}

export interface FlowDetail {
  flow: TrafficFlow;
  requestBodyText?: string;
  responseBodyText?: string;
  truncated: boolean;
}

export class FlowStore {
  constructor(private readonly reader: FlowReader) {}

  list(sessionId: string, filter: Partial<FlowFilter> & { limit?: number; offset?: number }) {
    const limit = Math.min(filter.limit ?? OUTPUT_LIMITS.maxListRows, OUTPUT_LIMITS.maxListRows);
    return this.reader.list(sessionId, { ...filter, limit, offset: filter.offset ?? 0 });
  }

  /**
   * Full detail with bodies decoded to text and bounded (binary bodies come
   * back as lossy previews). Bodies larger than the budget are truncated and
   * flagged.
   */
  getDetail(sessionId: string, flowId: string): FlowDetail | undefined {
    const flow = this.reader.get(flowId);
    if (!flow || flow.sessionId !== sessionId) return undefined;
    const requestBodyText = flow.requestBody
      ? this.bodyText(flow.requestBody.blobHash, OUTPUT_LIMITS.maxBodyBytes)
      : undefined;
    const responseBodyText = flow.responseBody
      ? this.bodyText(flow.responseBody.blobHash, OUTPUT_LIMITS.maxBodyBytes)
      : undefined;
    const truncated =
      (flow.requestBody?.size ?? 0) > OUTPUT_LIMITS.maxBodyBytes ||
      (flow.responseBody?.size ?? 0) > OUTPUT_LIMITS.maxBodyBytes;
    return { flow, requestBodyText, responseBodyText, truncated };
  }

  listByAction(actionId: string): TrafficFlow[] {
    return this.reader.listByAction(actionId);
  }

  recent(sessionId: string, seconds: number): TrafficFlow[] {
    return this.reader.recent(sessionId, Date.now() - seconds * 1000);
  }

  bodyText(hash: string, limitBytes = OUTPUT_LIMITS.maxBodyBytes): string | undefined {
    const bytes = this.reader.getBodyBytes(hash);
    if (!bytes) return undefined;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limitBytes));
  }
}
