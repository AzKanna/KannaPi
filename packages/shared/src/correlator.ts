/**
 * Action↔Flow correlation engine (ADR-003 — KannaPi's Innovation 3).
 *
 * Attribution algorithm, in order:
 *  1. TIME WINDOW (primary): a flow belongs to the unique action whose window
 *     [startedAt − pad, endedAt + pad] contains flow.timestampStart. Actions are
 *     executed serially, so windows rarely overlap.
 *  2. EVENT MATCH (tie-breaker): when zero or multiple windows match (background
 *     polling, overlapping windows), match the flow against a Playwright
 *     page-request event on (method, url) within a time tolerance — those events
 *     are recorded under the currently-executing action and carry its id.
 *
 * The proxy is the byte-level source of truth; Playwright events only provide
 * the action linkage (ADR-002).
 */
import { CORRELATION } from "@kanna/shared";

/** A Playwright-side request observation (recorded by @kanna/browser under the current action). */
export interface PageRequestEvent {
  url: string;
  method: string;
  wallTime: number;
  /** Action executing when the event fired (undefined = between actions / background). */
  actionId?: string;
  initiatorUrl?: string;
}

export interface ActionWindow {
  actionId: string;
  pageId: string;
  startedAt: number;
  endedAt?: number;
}

export interface AttributionResult {
  actionId?: string;
  pageId?: string;
  /** How the attribution was made (for auditability + attribution-rate metrics). */
  method: "window" | "event-match" | "none";
  initiatorUrl?: string;
}

/** How long a closed window stays matchable (late flow responses, settle grace). */
const RECENT_WINDOW_TTL_MS = 10_000;
const RECENT_WINDOW_MAX = 64;

export class Correlator {
  private open = new Map<string, ActionWindow>();
  private recent: ActionWindow[] = [];
  private pageEvents: PageRequestEvent[] = [];
  private readonly padMs: number;
  private readonly toleranceMs: number;

  constructor(
    padMs = CORRELATION.windowPadMs,
    toleranceMs = CORRELATION.eventMatchToleranceMs,
  ) {
    this.padMs = padMs;
    this.toleranceMs = toleranceMs;
  }

  actionStarted(window: ActionWindow): void {
    this.open.set(window.actionId, { ...window });
  }

  actionEnded(actionId: string, endedAt: number): void {
    const w = this.open.get(actionId);
    if (w) {
      w.endedAt = endedAt;
      this.open.delete(actionId);
      this.recent.push(w);
      if (this.recent.length > RECENT_WINDOW_MAX) {
        this.recent = this.recent.slice(-RECENT_WINDOW_MAX);
      }
    }
    this.pruneRecent(endedAt);
  }

  /** Called by the browser layer for every page.on('request') observation. */
  recordPageEvent(event: PageRequestEvent): void {
    this.pageEvents.push(event);
    if (this.pageEvents.length > 512) {
      this.pageEvents = this.pageEvents.slice(-512);
    }
  }

  /** Attribute a flow (identified by request timestamp + method + url) to an action. */
  attribute(flow: { timestampStart: number; method: string; url: string }): AttributionResult {
    // 1. time-window primary
    const candidates = [...this.open.values(), ...this.recent].filter((w) => {
      const from = w.startedAt - this.padMs;
      const to = (w.endedAt ?? Number.POSITIVE_INFINITY) + this.padMs;
      return flow.timestampStart >= from && flow.timestampStart <= to;
    });
    if (candidates.length === 1) {
      const c = candidates[0] as ActionWindow;
      return { actionId: c.actionId, pageId: c.pageId, method: "window" };
    }

    // 2. event-match tie-breaker (zero or multiple window candidates)
    const match = this.findPageEvent(flow.method, flow.url, flow.timestampStart);
    if (match && match.actionId) {
      const window = [...this.open.values(), ...this.recent].find(
        (w) => w.actionId === match.actionId,
      );
      return {
        actionId: match.actionId,
        pageId: window?.pageId,
        method: "event-match",
        initiatorUrl: match.initiatorUrl,
      };
    }
    if (match?.initiatorUrl) {
      return { method: "none", initiatorUrl: match.initiatorUrl };
    }
    return { method: "none" };
  }

  private findPageEvent(
    method: string,
    url: string,
    timestampStart: number,
  ): PageRequestEvent | undefined {
    let best: PageRequestEvent | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const e of this.pageEvents) {
      if (e.method !== method || e.url !== url) continue;
      const delta = Math.abs(e.wallTime - timestampStart);
      if (delta <= this.toleranceMs && delta < bestDelta) {
        best = e;
        bestDelta = delta;
      }
    }
    return best;
  }

  private pruneRecent(now: number): void {
    this.recent = this.recent.filter(
      (w) => now - (w.endedAt ?? w.startedAt) < RECENT_WINDOW_TTL_MS,
    );
  }

  /** Diagnostics for attribution-rate metrics (acceptance criterion ②). */
  stats(): { open: number; recent: number; pageEvents: number } {
    return { open: this.open.size, recent: this.recent.length, pageEvents: this.pageEvents.length };
  }
}
