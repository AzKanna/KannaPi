"""
KannaPi flow_sink — mitmproxy addon that pushes captured traffic to the Node backend.

Runs INSIDE the mitmdump process. Connects as a WebSocket CLIENT to the Node
ingest server and pushes one JSON object per event.

The wire contract is mirrored 1:1 from packages/shared/src/proxy-contract.ts (v1):
  flow_start / flow_request / flow_response / flow_error / websocket_message /
  scope_violation / addon_ready

Scope enforcement (ADR-002/004): the addon is the authoritative gate through which
ALL browser traffic must pass. Out-of-scope hosts are answered with a synthetic
403 and reported as scope_violation events. Defense in depth with the Node-side
ToolGuard — either can block independently.

Options (mitmdump --set kanna_*=value):
  kanna_ingest_url   ws://127.0.0.1:8081/proxy
  kanna_scope        comma-separated host[:port] allowlist; wildcard hosts
                     (*.example.com) and wildcard ports (host:*) supported
  kanna_max_body     max body bytes captured per request/response (default 512 KiB)

This addon is original KannaPi code (AGPL-adjacent: published with the thesis
source, see docs/adr/ADR-010-licensing.md).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any, Callable, NamedTuple, Optional

from mitmproxy import ctx as mitm_ctx
from mitmproxy import http

ADDON_VERSION = "0.1.0"
CONTRACT_VERSION = 1
DEFAULT_MAX_BODY = 512 * 1024
DEFAULT_INGEST_URL = "ws://127.0.0.1:8081/proxy"
RECONNECT_MIN_DELAY = 0.5
RECONNECT_MAX_DELAY = 5.0
QUEUE_MAX = 10_000

log = logging.getLogger("kanna.flow_sink")

try:
    import websockets
except ImportError:  # pragma: no cover - exercised only in broken environments
    websockets = None


# ---------------------------------------------------------------------------
# Scope gate (pure logic — unit tested)
# ---------------------------------------------------------------------------


class ScopeEntry(NamedTuple):
    host: str  # exact or "*.example.com"
    port: int  # -1 = any


def parse_scope(spec: str) -> list[ScopeEntry]:
    entries: list[ScopeEntry] = []
    for raw in spec.split(","):
        item = raw.strip().lower()
        if not item:
            continue
        if ":" in item:
            host, _, port_s = item.rpartition(":")
            port = -1 if port_s == "*" else int(port_s)
        else:
            host, port = item, -1
        if host:
            entries.append(ScopeEntry(host=host, port=port))
    return entries


def host_matches(pattern: str, host: str) -> bool:
    if pattern == host:
        return True
    if pattern.startswith("*."):
        suffix = pattern[1:]  # ".example.com"
        return host.endswith(suffix) and len(host) > len(suffix)
    return False


def in_scope(entries: list[ScopeEntry], host: str, port: int) -> bool:
    h = host.lower()
    return any(host_matches(e.host, h) and (e.port == -1 or e.port == port) for e in entries)


# ---------------------------------------------------------------------------
# Serialization helpers (pure logic — unit tested)
# ---------------------------------------------------------------------------


def serialize_headers(headers: Any) -> list[list[str]]:
    """Order- and duplicate-preserving header pairs (contract: HeaderPairsSchema)."""
    def header_text(value: Any) -> str:
        return value.decode("latin-1", errors="replace") if isinstance(value, bytes) else str(value)

    return [[header_text(k), header_text(v)] for k, v in headers.fields]


def body_payload(content: Optional[bytes], max_body: int) -> Optional[dict[str, Any]]:
    if content is None or len(content) == 0:
        return None
    truncated = len(content) > max_body
    data = content[:max_body] if truncated else content
    return {
        "b64": base64.b64encode(data).decode("ascii"),
        "size": len(content),
        "truncated": truncated,
    }


def base_event(kind: str) -> dict[str, Any]:
    return {"v": CONTRACT_VERSION, "kind": kind}


# ---------------------------------------------------------------------------
# Ingest client — queue + resilient background sender
# ---------------------------------------------------------------------------


class IngestClient:
    def __init__(self, url: str, on_command: Optional[Callable[[dict[str, Any]], None]] = None) -> None:
        self.url = url
        self.on_command = on_command
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=QUEUE_MAX)
        self.dropped = 0
        self._task: Optional[asyncio.Task] = None
        self.connected = False

    def emit(self, event: dict[str, Any]) -> None:
        """Non-blocking enqueue; drops (and counts) on overflow — never blocks the proxy."""
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.dropped += 1
            if self.dropped % 100 == 1:
                log.warning("ingest queue full, dropped %d events so far", self.dropped)

    async def start(self) -> None:
        if websockets is None:
            log.error("websockets package not available — events will queue but never send")
            return
        self._task = asyncio.get_running_loop().create_task(self._sender())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - shutdown path
                pass
            self._task = None

    async def _sender(self) -> None:
        delay = RECONNECT_MIN_DELAY
        while True:
            try:
                async with websockets.connect(self.url, max_size=2**22) as ws:
                    self.connected = True
                    delay = RECONNECT_MIN_DELAY
                    log.info("connected to ingest server %s", self.url)
                    await ws.send(
                        json.dumps(
                            base_event("addon_ready") | {"addonVersion": ADDON_VERSION}
                        )
                    )
                    sender = asyncio.create_task(self._send_events(ws))
                    receiver = asyncio.create_task(self._receive_commands(ws))
                    done, pending = await asyncio.wait(
                        {sender, receiver}, return_when=asyncio.FIRST_EXCEPTION
                    )
                    for task in pending:
                        task.cancel()
                    for task in done:
                        task.result()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - any transport error → reconnect
                self.connected = False
                log.warning("ingest connection error (%s); retrying in %.1fs", e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_DELAY)

    async def _send_events(self, ws: Any) -> None:
        while True:
            event = await self.queue.get()
            await ws.send(json.dumps(event))

    async def _receive_commands(self, ws: Any) -> None:
        async for raw in ws:
            try:
                command = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                log.warning("ignored malformed control command")
                continue
            if isinstance(command, dict) and self.on_command is not None:
                self.on_command(command)


# ---------------------------------------------------------------------------
# The addon
# ---------------------------------------------------------------------------


class KannaFlowSink:
    def __init__(self) -> None:
        self.client = IngestClient(DEFAULT_INGEST_URL, self._handle_command)
        self.scope: list[ScopeEntry] = []
        self.max_body = DEFAULT_MAX_BODY
        self.intercept_enabled = False
        self.held_flows: dict[str, http.HTTPFlow] = {}

    # -- mitmproxy option registration --------------------------------------
    def load(self, loader: Any) -> None:
        loader.add_option(
            name="kanna_ingest_url",
            typespec=str,
            default=DEFAULT_INGEST_URL,
            help="WebSocket URL of the KannaPi Node ingest server",
        )
        loader.add_option(
            name="kanna_scope",
            typespec=str,
            default="",
            help="Comma-separated host[:port] allowlist enforced at the proxy",
        )
        loader.add_option(
            name="kanna_max_body",
            typespec=int,
            default=DEFAULT_MAX_BODY,
            help="Max body bytes captured per request/response",
        )
        loader.add_option(
            name="kanna_intercept",
            typespec=bool,
            default=False,
            help="Hold requests until KannaPi sends a forward/drop decision",
        )

    def configure(self, updated: set[str]) -> None:
        # ctx.options is injected at runtime by the mitmproxy master process.
        opts = mitm_ctx.options
        if "kanna_scope" in updated:
            self.scope = parse_scope(str(opts.kanna_scope))
            log.info("scope allowlist: %s", self.scope or "(empty — nothing enforced)")
        if "kanna_max_body" in updated:
            self.max_body = int(opts.kanna_max_body)
        if "kanna_ingest_url" in updated:
            self.client.url = str(opts.kanna_ingest_url)
        if "kanna_intercept" in updated:
            self._set_intercept(bool(opts.kanna_intercept))

    async def running(self) -> None:
        await self.client.start()

    async def done(self) -> None:
        self._set_intercept(False)
        await self.client.stop()

    # -- operator interception control --------------------------------------
    def _emit_decision(self, flow_key: str, action: str) -> None:
        self.client.emit(
            base_event("intercept_decision")
            | {"flowKey": flow_key, "action": action, "timestamp": time.time()}
        )

    def _set_intercept(self, enabled: bool) -> None:
        self.intercept_enabled = enabled
        if enabled:
            return
        for flow_key, flow in list(self.held_flows.items()):
            flow.resume()
            self._emit_decision(flow_key, "forward")
        self.held_flows.clear()

    def _handle_command(self, command: dict[str, Any]) -> None:
        kind = command.get("kind")
        if kind == "intercept_mode":
            self._set_intercept(bool(command.get("enabled")))
            return
        if kind != "intercept_decision":
            return
        flow_key = str(command.get("flowKey", ""))
        action = command.get("action")
        if action not in {"forward", "drop"}:
            return
        flow = self.held_flows.pop(flow_key, None)
        if flow is None:
            return
        if action == "drop":
            flow.response = http.Response.make(
                444,
                b"KannaPi: request dropped by operator\n",
                {"Content-Type": "text/plain", "X-Kanna-Intercept": "dropped"},
            )
        flow.resume()
        self._emit_decision(flow_key, str(action))

    # -- scope enforcement ----------------------------------------------------
    def _violation(self, method: str, url: str, host: str, reason: str) -> None:
        event = base_event("scope_violation")
        event |= {
            "method": method,
            "url": url,
            "host": host,
            "reason": reason,
            "timestamp": time.time(),
        }
        self.client.emit(event)
        log.warning("SCOPE VIOLATION blocked: %s %s (%s)", method, url, reason)

    def _check_scope(self, flow: http.HTTPFlow) -> bool:
        if not self.scope:
            return True  # no allowlist configured — do not enforce (ToolGuard still guards)
        host = flow.request.pretty_host.lower()
        port = flow.request.port
        if not in_scope(self.scope, host, port):
            flow.response = http.Response.make(
                403,
                b"KannaPi: target out of scope\n",
                {"Content-Type": "text/plain", "X-Kanna-Scope": "violation"},
            )
            self._violation(flow.request.method, flow.request.pretty_url, host,
                            f"host '{host}:{port}' not in scope allowlist")
            return False
        return True

    def http_connect(self, flow: http.HTTPFlow) -> None:
        """HTTPS: block at CONNECT time (before TLS). Non-2xx CONNECT aborts the tunnel."""
        if not self.scope:
            return
        host = flow.request.pretty_host.lower()
        port = flow.request.port
        if not in_scope(self.scope, host, port):
            flow.response = http.Response.make(
                403, b"KannaPi: target out of scope\n", {"Content-Type": "text/plain"}
            )
            self._violation("CONNECT", f"{host}:{port}", host,
                            f"host '{host}:{port}' not in scope allowlist")

    # -- event hooks -----------------------------------------------------------
    def requestheaders(self, flow: http.HTTPFlow) -> None:
        if flow.type != "http":
            return
        client_port = 0
        peername = getattr(flow.client_conn, "peername", None) if flow.client_conn else None
        if peername and len(peername) >= 2:
            try:
                client_port = int(peername[1])
            except (TypeError, ValueError):
                client_port = 0
        source_hint = flow.request.headers.get("X-Kanna-Source", None)
        event = base_event("flow_start")
        event |= {
            "flowKey": flow.id,
            "timestampStart": flow.request.timestamp_start or time.time(),
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "host": flow.request.pretty_host.lower(),
            "port": flow.request.port,
            "path": flow.request.path,
            "clientPort": client_port,
        }
        if source_hint:
            event["sourceHint"] = source_hint
        self.client.emit(event)

    def request(self, flow: http.HTTPFlow) -> None:
        if flow.type != "http":
            return
        if not self._check_scope(flow):
            return  # synthetic 403 already set; response hook will capture it
        event = base_event("flow_request")
        event |= {
            "flowKey": flow.id,
            "headers": serialize_headers(flow.request.headers),
            "timestampEnd": flow.request.timestamp_end or time.time(),
        }
        body = body_payload(getattr(flow.request, "content", None), self.max_body)
        if body is not None:
            event["body"] = body
        self.client.emit(event)
        if self.intercept_enabled:
            flow.intercept()
            self.held_flows[flow.id] = flow
            self.client.emit(
                base_event("intercept_pending")
                | {"flowKey": flow.id, "timestamp": time.time()}
            )

    def response(self, flow: http.HTTPFlow) -> None:
        if flow.type != "http":
            return
        response = flow.response
        assert response is not None
        timing = self._timing(flow)
        event = base_event("flow_response")
        event |= {
            "flowKey": flow.id,
            "statusCode": response.status_code,
            "headers": serialize_headers(response.headers),
            "timestampEnd": response.timestamp_end or time.time(),
        }
        content_type = response.headers.get("content-type", None)
        if content_type:
            event["contentType"] = content_type
        body = body_payload(getattr(response, "content", None), self.max_body)
        if body is not None:
            event["body"] = body
        if timing:
            event["timing"] = timing
        self.client.emit(event)

    def error(self, flow: http.HTTPFlow) -> None:
        if flow.type != "http":
            return
        event = base_event("flow_error")
        event |= {
            "flowKey": flow.id,
            "error": str(getattr(flow, "error", "unknown error")),
            "timestamp": time.time(),
        }
        self.client.emit(event)

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        if not flow.websocket:
            return
        message = flow.websocket.messages[-1]
        event = base_event("websocket_message")
        event |= {
            "flowKey": flow.id,
            "fromClient": bool(message.from_client),
            "payloadB64": base64.b64encode(message.content).decode("ascii"),
            "timestamp": message.timestamp or time.time(),
        }
        self.client.emit(event)

    # -- internals ---------------------------------------------------------------
    def _timing(self, flow: http.HTTPFlow) -> dict[str, float]:
        timing: dict[str, float] = {}
        req = flow.request
        res = flow.response
        assert res is not None
        sc = flow.server_conn
        tcp = getattr(sc, "timestamp_tcp_setup", None)
        tls = getattr(sc, "timestamp_tls_setup", None)
        if req.timestamp_start and tcp:
            timing["connectMs"] = round(tcp - req.timestamp_start, 3)
        if tcp and tls:
            timing["tlsMs"] = round(tls - tcp, 3)
        if req.timestamp_end and res.timestamp_start:
            timing["ttfbMs"] = round(res.timestamp_start - req.timestamp_end, 3)
        if req.timestamp_start and res.timestamp_end:
            timing["totalMs"] = round(res.timestamp_end - req.timestamp_start, 3)
        return timing


addons = [KannaFlowSink()]
