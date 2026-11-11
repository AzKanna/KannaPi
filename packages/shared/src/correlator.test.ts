import { describe, expect, it } from "vitest";
import { Correlator } from "./correlator.js";

const T0 = 1_700_000_000_000; // fixed epoch ms base

describe("Correlator — time-window primary attribution", () => {
  it("attributes a flow inside a unique open action window", () => {
    const c = new Correlator();
    c.actionStarted({ actionId: "act_1", pageId: "page_1", startedAt: T0 });
    const r = c.attribute({ timestampStart: T0 + 100, method: "GET", url: "http://x/1" });
    expect(r.actionId).toBe("act_1");
    expect(r.pageId).toBe("page_1");
    expect(r.method).toBe("window");
  });

  it("attributes within the padding window (before start / after end)", () => {
    const c = new Correlator(250);
    c.actionStarted({ actionId: "act_1", pageId: "p", startedAt: T0 });
    // request started slightly before the recorded action start
    expect(c.attribute({ timestampStart: T0 - 200, method: "GET", url: "u" }).actionId).toBe("act_1");
    // beyond padding → no window attribution
    expect(c.attribute({ timestampStart: T0 - 500, method: "GET", url: "u" }).actionId).toBeUndefined();
  });

  it("attributes flows to recently closed windows (late responses / settle grace)", () => {
    const c = new Correlator();
    c.actionStarted({ actionId: "act_1", pageId: "p", startedAt: T0 });
    c.actionEnded("act_1", T0 + 1000);
    const r = c.attribute({ timestampStart: T0 + 900, method: "GET", url: "http://x/1" });
    expect(r.actionId).toBe("act_1");
  });

  it("does not attribute to expired windows", () => {
    const c = new Correlator();
    c.actionStarted({ actionId: "act_1", pageId: "p", startedAt: T0 });
    c.actionEnded("act_1", T0 + 1000);
    // prune: end another action far in the future to trigger cleanup
    c.actionStarted({ actionId: "act_2", pageId: "p", startedAt: T0 + 60_000 });
    c.actionEnded("act_2", T0 + 61_000);
    const r = c.attribute({ timestampStart: T0 + 2000, method: "GET", url: "http://x/1" });
    expect(r.method).toBe("none");
  });

  it("does not attribute background traffic between actions", () => {
    const c = new Correlator();
    c.actionStarted({ actionId: "act_1", pageId: "p", startedAt: T0 });
    c.actionEnded("act_1", T0 + 500);
    const r = c.attribute({ timestampStart: T0 + 30_000, method: "GET", url: "http://x/poll" });
    expect(r.actionId).toBeUndefined();
    expect(r.method).toBe("none");
  });
});

describe("Correlator — event-match tie-breaker", () => {
  it("resolves overlapping windows via a matching page event", () => {
    const c = new Correlator();
    // two overlapping windows (nested actions shouldn't happen, but robustness)
    c.actionStarted({ actionId: "act_a", pageId: "p", startedAt: T0 });
    c.actionStarted({ actionId: "act_b", pageId: "p", startedAt: T0 + 50 });
    // page event fired under action_b for this exact request
    c.recordPageEvent({ url: "http://x/api", method: "GET", wallTime: T0 + 100, actionId: "act_b" });
    const r = c.attribute({ timestampStart: T0 + 110, method: "GET", url: "http://x/api" });
    expect(r.actionId).toBe("act_b");
    expect(r.method).toBe("event-match");
  });

  it("event-matches a flow when no window matched (poll fired during settle)", () => {
    const c = new Correlator();
    c.actionStarted({ actionId: "act_a", pageId: "p", startedAt: T0 });
    c.actionEnded("act_a", T0 + 500);
    // page event fired after the window (+padding) closed, still carrying the action id
    c.recordPageEvent({ url: "http://x/api", method: "GET", wallTime: T0 + 900, actionId: "act_a" });
    // flow timestamp beyond window padding (T0+750) but within event tolerance of the page event
    const r = c.attribute({ timestampStart: T0 + 950, method: "GET", url: "http://x/api" });
    expect(r.actionId).toBe("act_a");
    expect(r.method).toBe("event-match");
  });

  it("returns initiator metadata for unattributed but observed requests", () => {
    const c = new Correlator();
    c.recordPageEvent({
      url: "http://x/bg.js",
      method: "GET",
      wallTime: T0,
      initiatorUrl: "http://x/index",
    });
    const r = c.attribute({ timestampStart: T0 + 20, method: "GET", url: "http://x/bg.js" });
    expect(r.actionId).toBeUndefined();
    expect(r.initiatorUrl).toBe("http://x/index");
  });

  it("rejects page events outside the time tolerance", () => {
    const c = new Correlator();
    c.recordPageEvent({ url: "http://x/api", method: "GET", wallTime: T0, actionId: "act_a" });
    const r = c.attribute({ timestampStart: T0 + 5_000, method: "GET", url: "http://x/api" });
    expect(r.method).toBe("none");
  });

  it("rejects page events with different method or url", () => {
    const c = new Correlator();
    c.recordPageEvent({ url: "http://x/api", method: "GET", wallTime: T0, actionId: "act_a" });
    expect(c.attribute({ timestampStart: T0, method: "POST", url: "http://x/api" }).method).toBe(
      "none",
    );
    expect(c.attribute({ timestampStart: T0, method: "GET", url: "http://x/other" }).method).toBe(
      "none",
    );
  });
});

describe("Correlator — bookkeeping", () => {
  it("tracks stats", () => {
    const c = new Correlator();
    c.actionStarted({ actionId: "a", pageId: "p", startedAt: T0 });
    c.recordPageEvent({ url: "u", method: "GET", wallTime: T0 });
    expect(c.stats()).toEqual({ open: 1, recent: 0, pageEvents: 1 });
  });
});
