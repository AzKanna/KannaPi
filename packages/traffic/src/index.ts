/**
 * @kanna/traffic — mitmproxy supervision, WS ingest, action↔flow correlation,
 * and the token-budgeted FlowStore facade (ADR-002/003).
 */
export { Correlator, type ActionWindow, type AttributionResult, type PageRequestEvent } from "@kanna/shared";
export {
  FlowIngestor,
  type ActionPersister,
  type AuditSink,
  type BodyStorage,
  type FlowIngestorOptions,
  type FlowPersister,
  type IngestStats,
  pairsToRecord,
} from "./flow-ingestor.js";
export { IngestServer, type IngestHttpHandler, type IngestServerOptions } from "./ingest-server.js";
export {
  ProxySupervisor,
  resolveAddonPath,
  resolveMitmdumpPath,
  type ProxySupervisorOptions,
} from "./proxy-supervisor.js";
export { FlowStore, type FlowDetail, type FlowReader } from "./flow-store.js";
export type { FlowFilter } from "./flow-repo-shapes.js";
