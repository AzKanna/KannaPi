/**
 * Wire contract between the mitmproxy addon (services/proxy/flow_sink.py, Python)
 * and the Node WS ingest server (@kanna/traffic).
 *
 * The addon is a WebSocket CLIENT connecting to ws://<ingestHost>:<ingestPort>/proxy
 * and pushes one JSON object per event. The proxy flow id (`flowKey`, mitmproxy's
 * flow.id) joins the parts of one flow (start → request → response/error [, ws messages]).
 *
 * Python side MUST mirror these shapes exactly. This file is the single source of
 * truth — validated on the Node side with Compile (malformed events are dropped
 * and counted, never crash the ingest loop).
 */
import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

/** Order-preserving, duplicate-preserving header pairs (evidence fidelity, burpwn-style). */
export const HeaderPairsSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]));
export type HeaderPairs = Static<typeof HeaderPairsSchema>;

/** Body payload: base64 of raw bytes, possibly truncated by the addon's maxBodyBytes. */
export const BodyPayloadSchema = Type.Object({
  b64: Type.String(),
  size: Type.Number(),
  truncated: Type.Boolean(),
});
export type BodyPayload = Static<typeof BodyPayloadSchema>;

export const FlowStartSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("flow_start"),
  /** mitmproxy flow.id — join key. */
  flowKey: Type.String(),
  timestampStart: Type.Number(),
  method: Type.String(),
  url: Type.String(),
  host: Type.String(),
  port: Type.Number(),
  path: Type.String(),
  /** Client (browser) source port — connection identity. */
  clientPort: Type.Number(),
  /** 'replay' | 'agent' when the request carried the X-Kanna-Source marker header. */
  sourceHint: Type.Optional(Type.String()),
});
export type FlowStartEvent = Static<typeof FlowStartSchema>;

export const FlowRequestSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("flow_request"),
  flowKey: Type.String(),
  headers: HeaderPairsSchema,
  body: Type.Optional(BodyPayloadSchema),
  timestampEnd: Type.Number(),
});
export type FlowRequestEvent = Static<typeof FlowRequestSchema>;

export const FlowResponseSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("flow_response"),
  flowKey: Type.String(),
  statusCode: Type.Number(),
  headers: HeaderPairsSchema,
  body: Type.Optional(BodyPayloadSchema),
  contentType: Type.Optional(Type.String()),
  timing: Type.Optional(
    Type.Object({
      dnsMs: Type.Optional(Type.Number()),
      connectMs: Type.Optional(Type.Number()),
      tlsMs: Type.Optional(Type.Number()),
      ttfbMs: Type.Optional(Type.Number()),
      totalMs: Type.Optional(Type.Number()),
    }),
  ),
  timestampEnd: Type.Number(),
});
export type FlowResponseEvent = Static<typeof FlowResponseSchema>;

export const FlowErrorSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("flow_error"),
  flowKey: Type.String(),
  error: Type.String(),
  timestamp: Type.Number(),
});
export type FlowErrorEvent = Static<typeof FlowErrorSchema>;

export const WebsocketMessageEventSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("websocket_message"),
  flowKey: Type.String(),
  fromClient: Type.Boolean(),
  payloadB64: Type.String(),
  timestamp: Type.Number(),
});
export type WebsocketMessageEvent = Static<typeof WebsocketMessageEventSchema>;

export const ScopeViolationEventSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("scope_violation"),
  method: Type.String(),
  url: Type.String(),
  host: Type.String(),
  reason: Type.String(),
  timestamp: Type.Number(),
});
export type ScopeViolationEvent = Static<typeof ScopeViolationEventSchema>;

/** Request paused by the proxy until the operator forwards or drops it. */
export const InterceptPendingEventSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("intercept_pending"),
  flowKey: Type.String(),
  timestamp: Type.Number(),
});
export type InterceptPendingEvent = Static<typeof InterceptPendingEventSchema>;

/** Confirmation that a held request received an operator decision. */
export const InterceptDecisionEventSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("intercept_decision"),
  flowKey: Type.String(),
  action: Type.Union([Type.Literal("forward"), Type.Literal("drop")]),
  timestamp: Type.Number(),
});
export type InterceptDecisionEvent = Static<typeof InterceptDecisionEventSchema>;

/** Sent once on connect so the supervisor knows the addon is alive. */
export const AddonReadyEventSchema = Type.Object({
  v: Type.Literal(1),
  kind: Type.Literal("addon_ready"),
  mitmproxyVersion: Type.Optional(Type.String()),
  addonVersion: Type.String(),
});
export type AddonReadyEvent = Static<typeof AddonReadyEventSchema>;

export const ProxyEventSchema = Type.Union([
  FlowStartSchema,
  FlowRequestSchema,
  FlowResponseSchema,
  FlowErrorSchema,
  WebsocketMessageEventSchema,
  ScopeViolationEventSchema,
  InterceptPendingEventSchema,
  InterceptDecisionEventSchema,
  AddonReadyEventSchema,
]);
export type ProxyEvent = Static<typeof ProxyEventSchema>;

const validateProxyEvent = Compile(ProxyEventSchema);

/** Type guard: is this JSON object a well-formed proxy event? */
export function isProxyEvent(obj: unknown): obj is ProxyEvent {
  return validateProxyEvent.Check(obj);
}

/** First validation error, for diagnostics (only meaningful when isProxyEvent is false). */
export function proxyEventIssues(obj: unknown): string[] {
  return [...validateProxyEvent.Errors(obj)].map(
    (e: { path?: string; message: string }) => `${e.path || "<root>"}: ${e.message}`,
  );
}
