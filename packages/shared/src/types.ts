/**
 * Core domain types (architecture §3).
 *
 * These are the shared vocabulary of every KannaPi package. Persistence rows,
 * tool results and WS events are all projections of these types.
 */

// ---------------------------------------------------------------------------
// Browser actions
// ---------------------------------------------------------------------------

export const BROWSER_ACTION_TYPES = [
  "navigate",
  "click",
  "type",
  "press_key",
  "submit",
  "back",
  "reload",
  "screenshot",
  "get_page",
  "get_state",
  "wait",
] as const;
export type BrowserActionType = (typeof BROWSER_ACTION_TYPES)[number];

export const BROWSER_ACTION_STATUSES = ["running", "completed", "failed", "blocked"] as const;
export type BrowserActionStatus = (typeof BROWSER_ACTION_STATUSES)[number];

export interface BrowserAction {
  /** `act_` prefixed uuidv7. */
  id: string;
  sessionId: string;
  /** Monotonic per-session sequence number (agent-friendly: "action #31"). */
  seq: number;
  type: BrowserActionType;
  params: Record<string, unknown>;
  pageId: string;
  startedAt: number;
  endedAt?: number;
  status: BrowserActionStatus;
  error?: string;
  pageUrlBefore?: string;
  pageUrlAfter?: string;
  /** Flow ids attributed to this action's window (back-filled, ADR-003). */
  correlatedFlowIds: string[];
}

/** Action types expected to produce network traffic (zero-flow-escape detection). */
export const TRAFFIC_EXPECTING_ACTION_TYPES: readonly BrowserActionType[] = [
  "navigate",
  "click",
  "submit",
  "reload",
];

// ---------------------------------------------------------------------------
// Traffic flows
// ---------------------------------------------------------------------------

export const FLOW_SOURCES = ["browser", "agent", "replay"] as const;
export type FlowSource = (typeof FLOW_SOURCES)[number];

/** Reference to a content-addressed body blob (raw bytes live in the blobs table). */
export interface BodyRef {
  /** sha256 hex of the raw body bytes. */
  blobHash: string;
  size: number;
  mimeType?: string;
  /** Content-Encoding of the stored bytes (e.g. "gzip" if stored as received). */
  encoding?: string;
  truncated: boolean;
  /** Short text preview for list rows (safe characters only). */
  textPreview?: string;
}

export interface FlowTiming {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  ttfbMs?: number;
  totalMs?: number;
}

export interface FlowSecurityMetadata {
  scopeViolating?: boolean;
  redactionApplied?: boolean;
  /** Lazily computed passive-module flags (module ids). */
  passiveFlags?: string[];
}

export interface TrafficFlow {
  /** `flow_` prefixed uuidv7 (assigned Node-side on flow_start). */
  id: string;
  sessionId: string;
  /** mitmproxy flow id — join key for request/response/websocket parts. */
  proxyFlowKey: string;
  timestampStart: number;
  timestampEnd?: number;
  method: string;
  url: string;
  host: string;
  port?: number;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody?: BodyRef;
  statusCode?: number;
  responseHeaders: Record<string, string>;
  responseBody?: BodyRef;
  contentType?: string;
  source: FlowSource;
  /** ADR-003 correlation. */
  browserActionId?: string;
  browserPageId?: string;
  /** Playwright-side metadata bound via event matching (disambiguation). */
  initiatorUrl?: string;
  timing: FlowTiming;
  securityMetadata: FlowSecurityMetadata;
  /** WebSocket messages captured for this flow (if any). */
  websocketMessages?: WebsocketMessageRecord[];
}

export interface WebsocketMessageRecord {
  fromClient: boolean;
  payloadB64: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Endpoints & parameters (deduplicated aggregates)
// ---------------------------------------------------------------------------

export const PARAMETER_LOCATIONS = ["query", "body", "path", "header"] as const;
export type ParameterLocation = (typeof PARAMETER_LOCATIONS)[number];

export interface EndpointParameter {
  name: string;
  locations: ParameterLocation[];
  observedTypes?: string[];
  /** Truncated sample values (for the LLM; secrets redacted). */
  sampleValues?: unknown[];
}

export const ENDPOINT_TEST_STATES = ["untested", "queued", "in_progress", "tested"] as const;
export type EndpointTestState = (typeof ENDPOINT_TEST_STATES)[number];

export interface Endpoint {
  /** `ep_` prefixed id; stable per (host, method, pathTemplate). */
  id: string;
  host: string;
  method: string;
  /** Normalized path, e.g. `/rest/products/:id`. */
  pathTemplate: string;
  parameters: EndpointParameter[];
  contentTypes: string[];
  authRequired: boolean | "unknown";
  observedStatusCodes: number[];
  /** Last N flow ids (bounded ring, for evidence lookup). */
  observedFromFlowIds: string[];
  firstSeen: number;
  lastSeen: number;
  /** Anti-redundant-testing marker (BurpAI AttackGraph idea). */
  testState: EndpointTestState;
}

export interface EndpointRef {
  method: string;
  pathTemplate: string;
  host?: string;
}

// ---------------------------------------------------------------------------
// Application state model
// ---------------------------------------------------------------------------

export interface PageRecord {
  id: string;
  url: string;
  title?: string;
  /** Action that first observed this page. */
  actionId?: string;
  timestamp: number;
  formCount: number;
  linkCount: number;
}

export interface FormField {
  name: string;
  type: string;
  value?: string;
}

export interface FormRecord {
  pageUrl: string;
  action?: string;
  method: string;
  fields: FormField[];
  actionId?: string;
}

export interface ParameterIndex {
  name: string;
  locations: ParameterLocation[];
  endpoints: EndpointRef[];
  sampleValues?: unknown[];
  flowIds: string[];
}

export interface CookieSummary {
  name: string;
  domain?: string;
  path?: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  session?: boolean;
}

export interface AuthState {
  loggedIn?: boolean;
  cookieNames: string[];
  tokenHeaders: string[];
  /** Flow ids that evidenced these observations. */
  evidence: string[];
}

export interface TechnologyFingerprint {
  name: string;
  category: "server" | "framework" | "language" | "database" | "cdn" | "other";
  evidence: string;
  confidence: "low" | "medium" | "high";
}

export interface ApplicationState {
  sessionId: string;
  updatedAt: number;
  pages: PageRecord[];
  endpoints: Endpoint[];
  parameters: ParameterIndex[];
  forms: FormRecord[];
  authState: AuthState;
  cookies: CookieSummary[];
  technologies: TechnologyFingerprint[];
  /** actionId → flowIds adjacency (the correlation graph). */
  trafficGraph: Array<{ actionId: string; flowIds: string[] }>;
  findings: string[];
  testedHypotheses: string[];
}

// ---------------------------------------------------------------------------
// Security reasoning: observations, hypotheses, tests, findings
// ---------------------------------------------------------------------------

export const FINDING_CATEGORIES = [
  "security-headers",
  "cookie-flags",
  "cors",
  "csp",
  "information-disclosure",
  "sensitive-data",
  "server-fingerprint",
  "secrets",
  "suspicious-parameters",
  "reflected-xss",
  "sql-injection",
  "idor",
  "open-redirect",
  "csrf",
  "path-traversal",
  "authentication",
  "session-management",
  "business-logic",
  "other",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const FINDING_STATUSES = ["suspected", "confirmed", "false_positive", "needs_review"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Deterministic output of a passive analysis module (ADR-007). */
export interface Observation {
  /** `obs_` prefixed id. */
  id: string;
  /** Passive module id, e.g. "security-headers". */
  moduleId: string;
  category: FindingCategory;
  title: string;
  detail: string;
  /** Flow that triggered the observation. */
  flowId: string;
  severityHint: Severity;
  wstgIds?: string[];
  timestamp: number;
}

export const HYPOTHESIS_STATUSES = ["open", "testing", "resolved", "dismissed"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface SecurityHypothesis {
  /** `hyp_` prefixed id. */
  id: string;
  category: FindingCategory;
  title: string;
  /** Observation-based reasoning chain — why we believe this might be true. */
  rationale: string;
  basedOnFlowIds: string[];
  basedOnActionIds: string[];
  endpoint?: EndpointRef;
  parameter?: string;
  /** 0..1 LLM self-assessed confidence. */
  confidence: number;
  priority: Priority;
  status: HypothesisStatus;
  createdAt: number;
  updatedAt: number;
}

/** One planned minimal request of a SecurityTest (never payload spraying, ADR-007). */
export interface TestRequestSpec {
  description: string;
  /** If set, this request is a modification of a captured baseline flow. */
  baseFlowId?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** What signal would support/refute the hypothesis. */
  expect: string;
}

export const TEST_OUTCOMES = ["supports", "refutes", "inconclusive"] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

export interface SecurityTest {
  /** `tst_` prefixed id. */
  id: string;
  hypothesisId: string;
  /** Strategy slug, e.g. "idor-swap-object-id". */
  strategy: string;
  plannedRequests: TestRequestSpec[];
  baselineFlowId?: string;
  result?: {
    outcome: TestOutcome;
    evidenceFlowIds: string[];
    notes: string;
  };
  /** Execution precondition (ADR-004 Tier 3). */
  policy: {
    approvedBy?: "human" | "auto-policy";
    approvalId?: string;
  };
}

export interface EvidenceRef {
  flowIds: string[];
  /** Bounded excerpts from captured traffic (proof, not hearsay). */
  excerpts?: string[];
  screenshotPaths?: string[];
  notes?: string;
}

export interface Finding {
  /** `fnd_` prefixed id. */
  id: string;
  title: string;
  category: FindingCategory;
  severity: Severity;
  confidence: Confidence;
  endpoint?: EndpointRef;
  parameter?: string;
  description: string;
  hypothesisId?: string;
  evidence: EvidenceRef;
  /** Flow ids needed to reproduce (user spec field). */
  requestIds: string[];
  reproduction: string;
  remediation: string;
  /** `confirmed` requires evidence — enforced by security_report_finding tool. */
  status: FindingStatus;
  wstgIds?: string[];
  cweId?: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Safety layer: scope & audit
// ---------------------------------------------------------------------------

export const ALLOWED_PROTOCOLS = ["http", "https", "ws", "wss"] as const;
export type AllowedProtocol = (typeof ALLOWED_PROTOCOLS)[number];

export interface Scope {
  id: string;
  name: string;
  /** Exact hosts or wildcard patterns like `*.example.com`. Default: localhost labs only. */
  allowedHosts: string[];
  allowedPorts: number[];
  allowedProtocols: AllowedProtocol[];
  maxRequestsPerSecond: number;
  maxRequestsTotal?: number;
  /** Master switch for Tier 3 tools (active testing). Default false. */
  activeTesting: boolean;
  createdAt: number;
  expiresAt?: number;
}

export const AUDIT_ACTORS = ["agent", "tool", "human", "system"] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AUDIT_EVENT_TYPES = [
  "tool_call",
  "policy_decision",
  "approval_request",
  "approval_result",
  "scope_check",
  "rate_limit",
  "session",
  "config",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_DECISIONS = ["allow", "deny", "blocked", "error"] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

export interface AuditEvent {
  /** `aud_` prefixed id. */
  id: string;
  timestamp: number;
  actor: AuditActor;
  eventType: AuditEventType;
  toolName?: string;
  actionId?: string;
  flowId?: string;
  decision?: AuditDecision;
  reason?: string;
  /** Redacted extra context (SecretRedactor applied before persisting). */
  details?: Record<string, unknown>;
}

/** Approval record (ApprovalManager, ADR-004). */
export interface Approval {
  /** `apr_` prefixed id. */
  id: string;
  requestedAt: number;
  decidedAt?: number;
  /** What needs approval, human readable. */
  summary: string;
  /** Serialized request that would be executed (for informed consent). */
  payload: Record<string, unknown>;
  decision?: "approved" | "denied" | "timeout";
  decidedBy?: "human";
}
