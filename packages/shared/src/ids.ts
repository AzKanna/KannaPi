import { uuidv7 } from "uuidv7";

/** Entity id prefixes. Ids are `<prefix>_<uuidv7>` — uuidv7 is time-ordered, index-friendly. */
export const ID_PREFIXES = [
  "act", // BrowserAction
  "flow", // TrafficFlow
  "ep", // Endpoint
  "pg", // PageRecord
  "hyp", // SecurityHypothesis
  "tst", // SecurityTest
  "fnd", // Finding
  "obs", // Observation (passive module output)
  "aud", // AuditEvent
  "apr", // Approval
  "sess", // Scan session
  "prj", // General Agent project
  "asset", // Project asset
  "att", // Agent message attachment
  "ssh", // Project SSH host
  "sshcmd", // SSH command execution
  "rpt", // Request Lab tab
  "rpx", // Request Lab exchange
  "agent", // General Agent workspace/session
  "chat", // Durable Agent chat session
  "bss", // Bench challenge session
  "bmsg", // Bench session message
  "skill", // Agent Skill attachment
  "plugin", // Explicitly trusted Pi extension
  "mcp", // Agent MCP server
  "run", // Agent Attack Graph run
  "node", // Attack Graph node
  "edge", // Attack Graph edge
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Generate a new time-ordered prefixed id, e.g. `act_018f3a2b-...`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${uuidv7()}`;
}

/** Extract the prefix of a prefixed id, or undefined if malformed. */
export function idPrefixOf(id: string): IdPrefix | undefined {
  const i = id.indexOf("_");
  if (i <= 0) return undefined;
  const p = id.slice(0, i) as IdPrefix;
  return (ID_PREFIXES as readonly string[]).includes(p) ? p : undefined;
}
