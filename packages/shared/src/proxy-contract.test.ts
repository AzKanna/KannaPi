import { describe, expect, it } from "vitest";
import {
  type FlowStartEvent,
  type ProxyEvent,
  isProxyEvent,
  proxyEventIssues,
} from "./proxy-contract.js";

const flowStart: FlowStartEvent = {
  v: 1,
  kind: "flow_start",
  flowKey: "mitm-flow-1",
  timestampStart: Date.now(),
  method: "GET",
  url: "http://localhost:3000/rest/products",
  host: "localhost",
  port: 3000,
  path: "/rest/products",
  clientPort: 51234,
};

describe("proxy contract validation", () => {
  it("accepts a well-formed flow_start", () => {
    expect(isProxyEvent(flowStart)).toBe(true);
    expect(proxyEventIssues(flowStart)).toEqual([]);
  });

  it("accepts flow_request with header pairs and optional body", () => {
    const e: ProxyEvent = {
      v: 1,
      kind: "flow_request",
      flowKey: "mitm-flow-1",
      headers: [
        ["Host", "localhost:3000"],
        ["User-Agent", "test"],
      ],
      body: { b64: "aGVsbG8=", size: 5, truncated: false },
      timestampEnd: Date.now(),
    };
    expect(isProxyEvent(e)).toBe(true);
  });

  it("accepts flow_response with timing", () => {
    const e: ProxyEvent = {
      v: 1,
      kind: "flow_response",
      flowKey: "mitm-flow-1",
      statusCode: 200,
      headers: [["Content-Type", "application/json"]],
      body: { b64: "W10=", size: 2, truncated: false },
      contentType: "application/json",
      timing: { ttfbMs: 12, totalMs: 40 },
      timestampEnd: Date.now(),
    };
    expect(isProxyEvent(e)).toBe(true);
  });

  it("accepts scope_violation and addon_ready", () => {
    expect(
      isProxyEvent({
        v: 1,
        kind: "scope_violation",
        method: "GET",
        url: "http://evil.example.com/",
        host: "evil.example.com",
        reason: "host not in allowedHosts",
        timestamp: Date.now(),
      }),
    ).toBe(true);
    expect(isProxyEvent({ v: 1, kind: "addon_ready", addonVersion: "0.1.0" })).toBe(true);
  });

  it("rejects malformed events with actionable issues", () => {
    const bad = { v: 1, kind: "flow_start", flowKey: "x" };
    expect(isProxyEvent(bad)).toBe(false);
    expect(proxyEventIssues(bad).join("\n")).toContain("timestampStart");
  });

  it("rejects unknown kinds", () => {
    expect(isProxyEvent({ v: 1, kind: "made_up", whatever: 1 })).toBe(false);
  });

  it("rejects wrong contract version", () => {
    expect(isProxyEvent({ ...flowStart, v: 2 })).toBe(false);
  });
});
