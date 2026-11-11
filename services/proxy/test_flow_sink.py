"""Unit tests for KannaPi flow_sink addon (pure logic parts + event emission)."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from flow_sink import (  # noqa: E402
    KannaFlowSink,
    ScopeEntry,
    base_event,
    body_payload,
    host_matches,
    in_scope,
    parse_scope,
    serialize_headers,
)


class HeaderStub:
    def __init__(self, fields):
        self.fields = fields

    def get(self, name, default=None):
        for k, v in self.fields:
            if k.lower() == name.lower():
                return v
        return default


class RequestStub:
    def __init__(self, method="GET", pretty_url="http://localhost:3000/x", host="localhost", port=3000):
        self.method = method
        self.pretty_url = pretty_url
        self.pretty_host = host
        self.port = port
        self.headers = HeaderStub([])
        self.timestamp_start = 1000.0
        self.timestamp_end = 1050.0
        self.content = None
        self.path = "/x"


class ResponseStub:
    def __init__(self, status_code=200, headers=None):
        self.status_code = status_code
        self.headers = HeaderStub(headers or [])
        self.timestamp_start = 2000.0
        self.timestamp_end = 2100.0
        self.content = b'{"ok":true}'


class ConnStub:
    def __init__(self, peername=("127.0.0.1", 51234)):
        self.peername = peername


class FlowStub:
    """Minimal stand-in for mitmproxy.http.HTTPFlow."""

    def __init__(self, flow_id="mitm-1", response=None, request=None):
        self.type = "http"
        self.id = flow_id
        self.request = request or RequestStub()
        self.response = response
        self.client_conn = ConnStub()
        self.server_conn = type("SC", (), {"timestamp_tcp_setup": 1010.0, "timestamp_tls_setup": None})()
        self.websocket = None
        self.error = None
        self.intercepted = False
        self.resumed = False

    def intercept(self):
        self.intercepted = True

    def resume(self):
        self.resumed = True
        self.intercepted = False


class CapturingClient:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


# ---------------------------------------------------------------------------
# scope gate
# ---------------------------------------------------------------------------


class TestScopeParsing:
    def test_parse_basic(self):
        entries = parse_scope("localhost:3000, 127.0.0.1:3000")
        assert entries == [ScopeEntry("localhost", 3000), ScopeEntry("127.0.0.1", 3000)]

    def test_parse_wildcard_port(self):
        entries = parse_scope("*.example.com:*")
        assert entries == [ScopeEntry("*.example.com", -1)]

    def test_parse_host_only_any_port(self):
        assert parse_scope("localhost") == [ScopeEntry("localhost", -1)]

    def test_parse_empty(self):
        assert parse_scope("") == []
        assert parse_scope(" , ") == []

    def test_host_matches(self):
        assert host_matches("localhost", "localhost")
        assert host_matches("*.example.com", "a.example.com")
        assert not host_matches("*.example.com", "example.com")
        assert not host_matches("*.example.com", "badexample.com")

    def test_in_scope(self):
        entries = parse_scope("localhost:3000,*.internal.test")
        assert in_scope(entries, "localhost", 3000)
        assert not in_scope(entries, "localhost", 8080)
        assert in_scope(entries, "api.internal.test", 443)
        assert not in_scope(entries, "evil.com", 3000)


# ---------------------------------------------------------------------------
# serialization helpers
# ---------------------------------------------------------------------------


class TestSerialization:
    def test_headers_preserve_order_and_duplicates(self):
        headers = HeaderStub([("b", "2"), ("a", "1"), ("Set-Cookie", "x=1"), ("Set-Cookie", "y=2")])
        assert serialize_headers(headers) == [
            ["b", "2"], ["a", "1"], ["Set-Cookie", "x=1"], ["Set-Cookie", "y=2"],
        ]

    def test_headers_decode_mitmproxy_bytes(self):
        headers = HeaderStub([(b"Host", b"127.0.0.1:3999"), (b"X-Name", "value")])
        assert serialize_headers(headers) == [["Host", "127.0.0.1:3999"], ["X-Name", "value"]]

    def test_body_payload_none(self):
        assert body_payload(None, 100) is None
        assert body_payload(b"", 100) is None

    def test_body_payload_roundtrip(self):
        payload = body_payload(b"hello", 100)
        assert payload is not None
        assert payload["size"] == 5
        assert payload["truncated"] is False
        assert base64.b64decode(payload["b64"]) == b"hello"

    def test_body_payload_truncates(self):
        payload = body_payload(b"x" * 300, 100)
        assert payload is not None
        assert payload["size"] == 300
        assert payload["truncated"] is True
        assert len(base64.b64decode(payload["b64"])) == 100


# ---------------------------------------------------------------------------
# event emission via the addon hooks
# ---------------------------------------------------------------------------


def make_sink(scope="localhost:3000"):
    sink = KannaFlowSink()
    sink.scope = parse_scope(scope)
    sink.max_body = 1024
    sink.client = CapturingClient()
    return sink


class TestEventEmission:
    def test_flow_start_event_shape(self):
        sink = make_sink()
        flow = FlowStub(flow_id="mitm-abc")
        sink.requestheaders(flow)
        event = sink.client.events[-1]
        assert event["v"] == 1
        assert event["kind"] == "flow_start"
        assert event["flowKey"] == "mitm-abc"
        assert event["method"] == "GET"
        assert event["host"] == "localhost"
        assert event["port"] == 3000
        assert event["clientPort"] == 51234
        assert isinstance(event["timestampStart"], float)

    def test_flow_request_with_body(self):
        sink = make_sink()
        flow = FlowStub()
        flow.request.headers = HeaderStub([("Host", "localhost:3000")])
        flow.request.content = b'{"q":"apple"}'
        sink.request(flow)
        event = sink.client.events[-1]
        assert event["kind"] == "flow_request"
        assert event["headers"] == [["Host", "localhost:3000"]]
        assert base64.b64decode(event["body"]["b64"]) == b'{"q":"apple"}'

    def test_flow_response_with_timing(self):
        sink = make_sink()
        req = RequestStub()
        req.timestamp_start = 1000.0
        req.timestamp_end = 1050.0
        flow = FlowStub(request=req, response=ResponseStub(headers=[("content-type", "application/json")]))
        sink.response(flow)
        event = sink.client.events[-1]
        assert event["kind"] == "flow_response"
        assert event["statusCode"] == 200
        assert event["contentType"] == "application/json"
        assert event["timing"]["ttfbMs"] == 950.0  # 2000 - 1050
        assert event["timing"]["totalMs"] == 1100.0  # 2100 - 1000
        assert base64.b64decode(event["body"]["b64"]) == b'{"ok":true}'

    def test_flow_error_event(self):
        sink = make_sink()
        flow = FlowStub()
        flow.error = "connection refused"
        sink.error(flow)
        event = sink.client.events[-1]
        assert event["kind"] == "flow_error"
        assert event["error"] == "connection refused"

    def test_websocket_message_event(self):
        sink = make_sink()
        flow = FlowStub()
        msg = type("M", (), {"from_client": True, "content": b"hi", "timestamp": 123.0})()
        flow.websocket = type("WS", (), {"messages": [msg]})()
        sink.websocket_message(flow)
        event = sink.client.events[-1]
        assert event["kind"] == "websocket_message"
        assert event["fromClient"] is True
        assert base64.b64decode(event["payloadB64"]) == b"hi"

    def test_intercept_holds_until_forwarded(self):
        sink = make_sink()
        sink.intercept_enabled = True
        flow = FlowStub()
        sink.request(flow)
        assert flow.intercepted is True
        assert flow.id in sink.held_flows
        assert sink.client.events[-1]["kind"] == "intercept_pending"
        sink._handle_command({"kind": "intercept_decision", "flowKey": flow.id, "action": "forward"})
        assert flow.resumed is True
        assert flow.id not in sink.held_flows
        assert sink.client.events[-1]["action"] == "forward"

    def test_intercept_drop_returns_synthetic_response(self):
        sink = make_sink()
        sink.intercept_enabled = True
        flow = FlowStub()
        sink.request(flow)
        sink._handle_command({"kind": "intercept_decision", "flowKey": flow.id, "action": "drop"})
        assert flow.resumed is True
        assert flow.response is not None
        assert flow.response.status_code == 444


# ---------------------------------------------------------------------------
# scope enforcement at the proxy
# ---------------------------------------------------------------------------


class TestScopeEnforcement:
    def test_out_of_scope_request_gets_403_and_violation_event(self):
        sink = make_sink(scope="localhost:3000")
        flow = FlowStub(request=RequestStub(host="evil.example.com", port=443,
                                            pretty_url="https://evil.example.com/x"))
        flow.response = None
        allowed = sink._check_scope(flow)
        assert allowed is False
        assert flow.response is not None
        assert flow.response.status_code == 403
        violations = [e for e in sink.client.events if e["kind"] == "scope_violation"]
        assert len(violations) == 1
        assert violations[0]["host"] == "evil.example.com"

    def test_in_scope_request_passes(self):
        sink = make_sink(scope="localhost:3000")
        flow = FlowStub()
        flow.response = None
        assert sink._check_scope(flow) is True
        assert flow.response is None

    def test_empty_scope_disables_enforcement(self):
        sink = make_sink(scope="")
        flow = FlowStub(request=RequestStub(host="anything.example.com", port=9999))
        flow.response = None
        assert sink._check_scope(flow) is True

    def test_http_connect_blocks_out_of_scope(self):
        sink = make_sink(scope="localhost:3000")
        flow = FlowStub(request=RequestStub(method="CONNECT", host="evil.example.com", port=443))
        flow.response = None
        sink.http_connect(flow)
        assert flow.response is not None
        assert flow.response.status_code == 403


# ---------------------------------------------------------------------------
# contract cross-check with the TS side (golden snippets)
# ---------------------------------------------------------------------------


class TestContractConformance:
    def test_event_json_matches_expected_shape(self):
        sink = make_sink()
        flow = FlowStub(flow_id="mitm-x")
        sink.requestheaders(flow)
        event = sink.client.events[-1]
        serialized = json.loads(json.dumps(event))
        # exact key set of flow_start per packages/shared proxy-contract.ts
        assert set(serialized.keys()) == {
            "v", "kind", "flowKey", "timestampStart", "method",
            "url", "host", "port", "path", "clientPort",
        }
        assert serialized["v"] == 1
