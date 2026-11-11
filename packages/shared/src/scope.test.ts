import { describe, expect, it } from "vitest";
import { ScopeParseError, defaultLocalScope, matchHost, parseScopeFile, urlInScope } from "./scope.js";

const VALID_SCOPE = JSON.stringify({
  name: "juice-shop-lab",
  allowedHosts: ["localhost", "127.0.0.1"],
  allowedPorts: [3000],
  allowedProtocols: ["http", "https"],
  maxRequestsPerSecond: 10,
  activeTesting: false,
});

describe("parseScopeFile", () => {
  it("parses a valid scope file", () => {
    const scope = parseScopeFile(VALID_SCOPE);
    expect(scope.name).toBe("juice-shop-lab");
    expect(scope.allowedHosts).toEqual(["localhost", "127.0.0.1"]);
    expect(scope.activeTesting).toBe(false);
    expect(scope.id).toMatch(/^sess_/);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseScopeFile("{nope")).toThrow(ScopeParseError);
  });

  it("rejects missing required fields", () => {
    expect(() => parseScopeFile(JSON.stringify({ allowedHosts: ["localhost"] }))).toThrow(
      /allowedPorts|allowedProtocols|maxRequestsPerSecond|activeTesting/,
    );
  });

  it("rejects unknown protocol values", () => {
    const bad = JSON.stringify({
      allowedHosts: ["localhost"],
      allowedPorts: [3000],
      allowedProtocols: ["ftp"],
      maxRequestsPerSecond: 1,
      activeTesting: false,
    });
    expect(() => parseScopeFile(bad)).toThrow(ScopeParseError);
  });
});

describe("matchHost", () => {
  it("matches exact hosts case-insensitively", () => {
    expect(matchHost("LocalHost", "localhost")).toBe(true);
    expect(matchHost("localhost", "LOCALHOST")).toBe(true);
    expect(matchHost("localhost", "example.com")).toBe(false);
  });

  it("matches leading wildcards on subdomains only", () => {
    expect(matchHost("*.example.com", "a.example.com")).toBe(true);
    expect(matchHost("*.example.com", "a.b.example.com")).toBe(true);
    expect(matchHost("*.example.com", "example.com")).toBe(false);
    expect(matchHost("*.example.com", "notexample.com")).toBe(false);
  });
});

describe("urlInScope", () => {
  const scope = parseScopeFile(VALID_SCOPE);

  it("allows in-scope urls", () => {
    expect(urlInScope(scope, "http://localhost:3000/")).toEqual({ ok: true });
    expect(urlInScope(scope, "http://127.0.0.1:3000/rest/products")).toEqual({ ok: true });
  });

  it("rejects out-of-scope hosts with a reason", () => {
    const r = urlInScope(scope, "http://example.com:3000/");
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("not in allowedHosts") });
  });

  it("rejects out-of-scope ports", () => {
    const r = urlInScope(scope, "http://localhost:8080/");
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("port 8080") });
  });

  it("rejects disallowed protocols", () => {
    const r = urlInScope(scope, "ftp://localhost:3000/");
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("protocol") });
  });

  it("rejects expired scopes", () => {
    const expired = parseScopeFile(
      JSON.stringify({
        allowedHosts: ["localhost"],
        allowedPorts: [3000],
        allowedProtocols: ["http"],
        maxRequestsPerSecond: 1,
        activeTesting: false,
        expiresAt: Date.now() - 1000,
      }),
    );
    expect(urlInScope(expired, "http://localhost:3000/")).toEqual({
      ok: false,
      reason: expect.stringContaining("expired"),
    });
  });
});

describe("defaultLocalScope", () => {
  it("is localhost-only and passive by default", () => {
    const scope = defaultLocalScope();
    expect(scope.allowedHosts).toContain("localhost");
    expect(scope.activeTesting).toBe(false);
    expect(urlInScope(scope, "http://localhost:3000/")).toEqual({ ok: true });
    expect(urlInScope(scope, "https://example.com/").ok).toBe(false);
  });
});
