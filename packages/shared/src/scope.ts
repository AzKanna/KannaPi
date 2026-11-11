import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";
import { newId } from "./ids.js";
import { StringEnum } from "./schema-utils.js";
import type { AllowedProtocol, Scope } from "./types.js";

/** Shape of a scope JSON file (`--scope scope.local.json`). */
const ScopeFileSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Display name for this scope" })),
  allowedHosts: Type.Array(Type.String(), {
    description: "Exact hosts or wildcards like *.example.com (port-less)",
  }),
  allowedPorts: Type.Array(Type.Number(), { description: "Allowed target ports" }),
  allowedProtocols: Type.Array(StringEnum(["http", "https", "ws", "wss"])),
  maxRequestsPerSecond: Type.Number({ description: "Per-host token bucket rate" }),
  maxRequestsTotal: Type.Optional(Type.Number()),
  activeTesting: Type.Boolean({ description: "Master switch for Tier 3 (active) tools" }),
  expiresAt: Type.Optional(Type.Number()),
});
type ScopeFile = Static<typeof ScopeFileSchema>;

const validateScopeFile = Compile(ScopeFileSchema);

export class ScopeParseError extends Error {
  constructor(
    public readonly issues: string[],
  ) {
    super(`Invalid scope file: ${issues.join("; ")}`);
    this.name = "ScopeParseError";
  }
}

export function parseScopeFile(text: string): Scope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ScopeParseError([`not valid JSON: ${(e as Error).message}`]);
  }
  if (!validateScopeFile.Check(raw)) {
    const issues = [...validateScopeFile.Errors(raw)].map(
      (e: { path?: string; message: string }) => `${e.path || "<root>"}: ${e.message}`,
    );
    throw new ScopeParseError(issues);
  }
  const file = raw as ScopeFile;
  return {
    id: newId("sess"),
    name: file.name ?? "unnamed-scope",
    allowedHosts: file.allowedHosts,
    allowedPorts: file.allowedPorts,
    allowedProtocols: file.allowedProtocols as AllowedProtocol[],
    maxRequestsPerSecond: file.maxRequestsPerSecond,
    maxRequestsTotal: file.maxRequestsTotal,
    activeTesting: file.activeTesting,
    createdAt: Date.now(),
    expiresAt: file.expiresAt,
  };
}

/**
 * Host matching: exact match or leading-wildcard pattern.
 * `*.example.com` matches `a.example.com` but NOT `example.com` itself —
 * include both entries if both should be allowed. Case-insensitive.
 */
export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

export function hostAllowed(scope: Scope, host: string): boolean {
  return scope.allowedHosts.some((p) => matchHost(p, host));
}

export function portAllowed(scope: Scope, port: number): boolean {
  return scope.allowedPorts.includes(port);
}

export function urlInScope(scope: Scope, url: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` };
  }
  const protocol = parsed.protocol.replace(":", "");
  if (!scope.allowedProtocols.includes(protocol as AllowedProtocol)) {
    return {
      ok: false,
      reason: `protocol '${protocol}' not in scope (${scope.allowedProtocols.join(", ")})`,
    };
  }
  if (!hostAllowed(scope, parsed.hostname)) {
    return { ok: false, reason: `host '${parsed.hostname}' not in allowedHosts` };
  }
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === "https" || protocol === "wss"
      ? 443
      : 80;
  if (!portAllowed(scope, port)) {
    return { ok: false, reason: `port ${port} not in allowedPorts` };
  }
  if (scope.expiresAt !== undefined && Date.now() > scope.expiresAt) {
    return { ok: false, reason: "scope has expired" };
  }
  return { ok: true };
}

/** Conservative default: local labs only, passive analysis, modest rate. */
export function defaultLocalScope(ports: number[] = [3000, 4200, 8080, 8090, 8081, 9999]): Scope {
  return {
    id: newId("sess"),
    name: "local-labs",
    allowedHosts: ["localhost", "127.0.0.1", "::1"],
    allowedPorts: ports,
    allowedProtocols: ["http", "https", "ws", "wss"],
    maxRequestsPerSecond: 5,
    activeTesting: false,
    createdAt: Date.now(),
  };
}
