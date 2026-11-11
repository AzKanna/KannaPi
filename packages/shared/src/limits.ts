/**
 * Output budgets (ADR-006): Pi hard-truncates tool output at 50 KB / 2000 lines,
 * so every tool must paginate / bound itself below that ceiling.
 */
export const OUTPUT_LIMITS = {
  /** Max rows returned by list-style tools in one page. */
  maxListRows: 100,
  /** Max body bytes included per body in tool output. */
  maxBodyBytes: 8 * 1024,
  /** Characters of body preview embedded in list rows. */
  textPreviewChars: 256,
  /** Max characters for free-text fields the LLM writes (descriptions etc.). */
  maxDescriptionChars: 4000,
} as const;

/** Action↔flow correlation tuning (ADR-003). */
export const CORRELATION = {
  /** Padding around [t0, t1] when attributing flows to an action window. */
  windowPadMs: 250,
  /** Tolerance for (method, url) event matching between Playwright and proxy flow. */
  eventMatchToleranceMs: 150,
  /** networkidle wait timeout inside settle(). */
  settleNetworkIdleTimeoutMs: 5_000,
  /** Extra quiet period after networkidle (long-polling blind spot). */
  settleQuietPeriodMs: 300,
} as const;

/** Local topology defaults (ADR-002). */
export const PROXY_DEFAULTS = {
  listenHost: "127.0.0.1",
  listenPort: 8080,
  /** Node-side WebSocket ingest server port (addon connects here as a client). */
  ingestHost: "127.0.0.1",
  ingestPort: 8081,
  /** Bodies larger than this are truncated by the addon (bytes). */
  maxBodyBytes: 512 * 1024,
} as const;

/** UI WebSocket bus (same server as ingest, different path). */
export const WS_PATHS = {
  proxyIngest: "/proxy",
  ui: "/ui",
} as const;
