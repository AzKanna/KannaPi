import { basename } from "node:path";
import type { TsharkHttpRow } from "./pcap-tshark.js";
import { decryptTlsConversation, parseTlsKeyLog } from "./tls-keylog.js";

export interface PcapAsset {
  address: string;
  names: string[];
  sent: number;
  received: number;
  protocols: string[];
}
export interface PcapLink {
  source: string;
  target: string;
  protocol: string;
  packets: number;
  bytes: number;
  ports: number[];
}
export interface PcapHttp {
  id: string;
  source: string;
  target: string;
  port: number;
  method: string;
  path: string;
  host: string;
  status?: number;
  contentType?: string;
  requestPreview?: string;
  responsePreview?: string;
  requestRaw?: string;
  responseRaw?: string;
  fileIds: string[];
}
export interface PcapCredential {
  id: string;
  kind: string;
  source: string;
  target: string;
  username?: string;
  value: string;
  evidence: string;
}
export interface PcapWebshell {
  id: string;
  family: "Caidao" | "Behinder" | "AntSword";
  confidence: "low" | "medium";
  source: string;
  target: string;
  path: string;
  evidence: string[];
  httpId: string;
}
export interface PcapExport {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  source: string;
  httpId: string;
}
export interface PcapReport {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  format: "pcap" | "pcapng";
  packetCount: number;
  byteCount: number;
  captureSha256?: string;
  truncated: boolean;
  encryptedStreams: number;
  decryption: { status: "not-needed" | "key-required" | "partial" | "decrypted"; explanation: string };
  decryptedStreams?: number;
  tshark?: { status: "used" | "unavailable" | "failed"; httpRecords: number };
  assets: PcapAsset[];
  links: PcapLink[];
  http: PcapHttp[];
  credentials: PcapCredential[];
  webshells: PcapWebshell[];
  files: PcapExport[];
  warnings: string[];
}

interface Packet {
  linkType: number;
  bytes: Buffer;
}
interface Segment {
  sequence: number;
  bytes: Buffer;
}
interface Direction {
  source: string;
  target: string;
  sourcePort: number;
  targetPort: number;
  segments: Segment[];
  size: number;
  firstPacket: number;
}
interface Decoded {
  source: string;
  target: string;
  sourcePort: number;
  targetPort: number;
  protocol: "TCP" | "UDP" | "ICMP";
  payload: Buffer;
  sequence?: number;
}
interface HttpMessage {
  start: string;
  headers: Record<string, string>;
  body: Buffer;
}
interface ExtractedFile {
  id: string;
  name: string;
  mediaType: string;
  bytes: Buffer;
  source: string;
  httpId: string;
}

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_PACKETS = 200_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_STREAM_BYTES = 24 * 1024 * 1024;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HTTP = 1_000;
const MAX_ASSETS = 300;
const MAX_LINKS = 1_000;

function readPcap(bytes: Buffer): {
  format: "pcap" | "pcapng";
  packets: Packet[];
  truncated: boolean;
  warnings: string[];
} {
  if (bytes.length < 24 || bytes.length > MAX_CAPTURE_BYTES)
    throw new Error("PCAP capture must be between 24 bytes and 64 MB");
  const magic = bytes.subarray(0, 4).toString("hex");
  const packets: Packet[] = [];
  const warnings: string[] = [];
  let truncated = false;
  if (magic === "0a0d0d0a") {
    const interfaces: number[] = [];
    let offset = 0;
    let blocks = 0;
    let little = true;
    while (offset + 12 <= bytes.length && packets.length < MAX_PACKETS && blocks++ < MAX_PACKETS * 2) {
      const blockType = bytes.readUInt32LE(offset);
      if (blockType === 0x0a0d0d0a) {
        if (offset + 12 > bytes.length) throw new Error("Truncated PCAPNG section");
        const bom = bytes.subarray(offset + 8, offset + 12).toString("hex");
        if (bom !== "4d3c2b1a" && bom !== "1a2b3c4d") throw new Error("Invalid PCAPNG byte order");
        little = bom === "4d3c2b1a";
        interfaces.length = 0;
      }
      const u32 = (position: number) =>
        little ? bytes.readUInt32LE(position) : bytes.readUInt32BE(position);
      const u16 = (position: number) =>
        little ? bytes.readUInt16LE(position) : bytes.readUInt16BE(position);
      const length = u32(offset + 4);
      if (length < 12 || length % 4 || offset + length > bytes.length || u32(offset + length - 4) !== length)
        throw new Error("Invalid or truncated PCAPNG block");
      const type = little ? blockType : bytes.readUInt32BE(offset);
      if (type === 1 && length >= 20) interfaces.push(u16(offset + 8));
      if (type === 6 && length >= 32) {
        const index = u32(offset + 8);
        const captured = u32(offset + 20);
        if (captured <= length - 32 && interfaces[index] !== undefined)
          packets.push({
            linkType: interfaces[index]!,
            bytes: bytes.subarray(offset + 28, offset + 28 + captured),
          });
        else warnings.push("Skipped an invalid enhanced packet block");
      }
      if (type === 3 && length >= 16 && interfaces[0] !== undefined)
        packets.push({ linkType: interfaces[0]!, bytes: bytes.subarray(offset + 12, offset + length - 4) });
      offset += length;
    }
    if (offset !== bytes.length || packets.length >= MAX_PACKETS) truncated = true;
    return { format: "pcapng", packets, truncated, warnings };
  }
  const little = magic === "d4c3b2a1" || magic === "4d3cb2a1";
  if (!little && magic !== "a1b2c3d4" && magic !== "a1b23c4d")
    throw new Error("Unsupported PCAP capture format");
  const u32 = (position: number) => (little ? bytes.readUInt32LE(position) : bytes.readUInt32BE(position));
  const linkType = u32(20);
  let offset = 24;
  while (offset + 16 <= bytes.length && packets.length < MAX_PACKETS) {
    const captured = u32(offset + 8);
    if (captured > MAX_CAPTURE_BYTES || offset + 16 + captured > bytes.length)
      throw new Error("Truncated PCAP packet");
    packets.push({ linkType, bytes: bytes.subarray(offset + 16, offset + 16 + captured) });
    offset += 16 + captured;
  }
  if (offset !== bytes.length || packets.length >= MAX_PACKETS) truncated = true;
  return { format: "pcap", packets, truncated, warnings };
}

function ipv4(bytes: Buffer, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}
function ipv6(bytes: Buffer, offset: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(offset + i).toString(16));
  return groups.join(":");
}

function decodePacket(packet: Packet): Decoded | undefined {
  const bytes = packet.bytes;
  let offset = 0;
  let type = 0;
  if (packet.linkType === 1) {
    if (bytes.length < 14) return;
    type = bytes.readUInt16BE(12);
    offset = 14;
    for (let i = 0; i < 2 && (type === 0x8100 || type === 0x88a8); i++) {
      if (bytes.length < offset + 4) return;
      type = bytes.readUInt16BE(offset + 2);
      offset += 4;
    }
  } else if (packet.linkType === 101 && bytes.length) type = bytes[0]! >> 4 === 6 ? 0x86dd : 0x0800;
  else if (packet.linkType === 113 && bytes.length >= 16) {
    type = bytes.readUInt16BE(14);
    offset = 16;
  } else return;
  let source: string;
  let target: string;
  let protocol: number;
  let end: number;
  if (type === 0x0800) {
    if (bytes.length < offset + 20 || bytes[offset]! >> 4 !== 4) return;
    const headerLength = (bytes[offset]! & 15) * 4;
    const packetLength = bytes.readUInt16BE(offset + 2);
    if (headerLength < 20 || packetLength < headerLength || bytes.length < offset + headerLength) return;
    if ((bytes.readUInt16BE(offset + 6) & 0x1fff) !== 0) return;
    source = ipv4(bytes, offset + 12);
    target = ipv4(bytes, offset + 16);
    protocol = bytes[offset + 9]!;
    end = Math.min(bytes.length, offset + packetLength);
    offset += headerLength;
  } else if (type === 0x86dd) {
    if (bytes.length < offset + 40 || bytes[offset]! >> 4 !== 6) return;
    source = ipv6(bytes, offset + 8);
    target = ipv6(bytes, offset + 24);
    protocol = bytes[offset + 6]!;
    end = Math.min(bytes.length, offset + 40 + bytes.readUInt16BE(offset + 4));
    offset += 40;
  } else return;
  if (protocol === 6) {
    if (end < offset + 20) return;
    const headerLength = (bytes[offset + 12]! >> 4) * 4;
    if (headerLength < 20 || end < offset + headerLength) return;
    return {
      source,
      target,
      sourcePort: bytes.readUInt16BE(offset),
      targetPort: bytes.readUInt16BE(offset + 2),
      protocol: "TCP",
      sequence: bytes.readUInt32BE(offset + 4),
      payload: bytes.subarray(offset + headerLength, end),
    };
  }
  if (protocol === 17) {
    if (end < offset + 8) return;
    return {
      source,
      target,
      sourcePort: bytes.readUInt16BE(offset),
      targetPort: bytes.readUInt16BE(offset + 2),
      protocol: "UDP",
      payload: bytes.subarray(offset + 8, end),
    };
  }
  return { source, target, sourcePort: 0, targetPort: 0, protocol: "ICMP", payload: Buffer.alloc(0) };
}

function reassemble(segments: Segment[]): Buffer {
  if (!segments.length) return Buffer.alloc(0);
  const sorted = [...segments].sort((a, b) => a.sequence - b.sequence);
  const parts: Buffer[] = [];
  let next = sorted[0]!.sequence;
  for (const segment of sorted) {
    if (segment.sequence > next) break;
    const overlap = next - segment.sequence;
    if (overlap >= segment.bytes.length) continue;
    const part = segment.bytes.subarray(overlap);
    parts.push(part);
    next += part.length;
  }
  return Buffer.concat(parts);
}

function parseChunked(bytes: Buffer): { body: Buffer; consumed: number } | undefined {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (offset < bytes.length && total <= MAX_STREAM_BYTES) {
    const lineEnd = bytes.indexOf("\r\n", offset);
    if (lineEnd < 0) return;
    const size = Number.parseInt(bytes.toString("ascii", offset, lineEnd).split(";", 1)[0] ?? "", 16);
    if (!Number.isFinite(size) || size < 0 || size > MAX_STREAM_BYTES) return;
    offset = lineEnd + 2;
    if (size === 0) {
      if (bytes.toString("ascii", offset, offset + 2) !== "\r\n") return;
      return { body: Buffer.concat(chunks), consumed: offset + 2 };
    }
    if (
      offset + size + 2 > bytes.length ||
      bytes.toString("ascii", offset + size, offset + size + 2) !== "\r\n"
    )
      return;
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size + 2;
    total += size;
  }
}

function httpMessage(bytes: Buffer): { message: HttpMessage; consumed: number } | undefined {
  const headerEnd = bytes.indexOf("\r\n\r\n");
  if (headerEnd < 0 || headerEnd > 32_768) return;
  const head = bytes.toString("latin1", 0, headerEnd);
  const lines = head.split("\r\n");
  const start = lines.shift() ?? "";
  if (
    !/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ HTTP\/1\.[01]$/.test(start) &&
    !/^HTTP\/1\.[01] \d{3}\b/.test(start)
  )
    return;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const split = line.indexOf(":");
    if (split > 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim();
  }
  let body = bytes.subarray(headerEnd + 4);
  let consumed = bytes.length;
  const length = Number(headers["content-length"]);
  if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    const decoded = parseChunked(body);
    if (!decoded) return;
    body = decoded.body;
    consumed = headerEnd + 4 + decoded.consumed;
  } else if (
    headers["content-length"] !== undefined &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= MAX_STREAM_BYTES
  ) {
    if (body.length < length) return;
    body = body.subarray(0, length);
    consumed = headerEnd + 4 + length;
  } else if (start.startsWith("HTTP/")) {
    consumed = bytes.length;
  } else {
    body = Buffer.alloc(0);
    consumed = headerEnd + 4;
  }
  return { message: { start, headers, body }, consumed };
}

function httpMessages(bytes: Buffer): HttpMessage[] {
  const messages: HttpMessage[] = [];
  let offset = 0;
  while (offset < bytes.length && messages.length < 100) {
    const result = httpMessage(bytes.subarray(offset));
    if (!result || result.consumed <= 0) break;
    messages.push(result.message);
    offset += result.consumed;
  }
  return messages;
}

function preview(bytes: Buffer): string {
  if (!bytes.length) return "";
  const sample = bytes.subarray(0, 400);
  const printable = [...sample].filter(
    (byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127),
  ).length;
  return printable / sample.length < 0.8
    ? "[binary data]"
    : sample.toString("utf8").replace(/((?:password|passwd|pwd|token|secret)=)[^&\s]+/gi, "$1[redacted]");
}

function safeName(raw: string): string {
  const decoded = raw.trim().replace(/^['"]|['"]$/g, "");
  return (
    basename(decoded.replace(/\\/g, "/"))
      .replace(/[<>:"|?*]/g, "_")
      .split("")
      .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
      .join("")
      .slice(0, 120) || "object.bin"
  );
}

function detectWebshell(
  request: HttpMessage,
  response: HttpMessage | undefined,
  source: string,
  target: string,
  path: string,
  httpId: string,
): PcapWebshell[] {
  if (!request.start.startsWith("POST ")) return [];
  const body = request.body.subarray(0, 64_000).toString("latin1");
  const decoded = (() => {
    try {
      return decodeURIComponent(body.replace(/\+/g, " "));
    } catch {
      return body;
    }
  })();
  const scriptEndpoint = /\.(?:php|asp|aspx|jsp)(?:[?/]|$)/i.test(path);
  const form = new URLSearchParams(body);
  const values = [...form.values()].join("\n");
  const code = `${decoded}\n${values}`;
  const hasEvalDecode = /\b(?:eval|assert)\s*\([\s\S]{0,160}\bbase64_decode\s*\(/i.test(code);
  const opaque = (bytes: Buffer): boolean => {
    if (bytes.length < 32) return false;
    const sample = bytes.subarray(0, 512);
    const distinct = new Set(sample).size;
    const printable = [...sample].filter((byte) => byte >= 32 && byte <= 126).length;
    return distinct >= Math.min(20, sample.length * 0.55) && printable / sample.length < 0.75;
  };
  const opaqueCipher = (bytes: Buffer): boolean => {
    if (opaque(bytes)) return true;
    const encoded = bytes.toString("ascii").trim();
    if (encoded.length < 44 || encoded.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    const decodedBytes = Buffer.from(encoded, "base64");
    return decodedBytes.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "") && opaque(decodedBytes);
  };
  const findings: PcapWebshell[] = [];
  const add = (
    family: PcapWebshell["family"],
    confidence: PcapWebshell["confidence"],
    evidence: string[],
  ) => {
    findings.push({
      id: `ws-${httpId}-${family.toLowerCase()}`,
      family,
      confidence,
      source,
      target,
      path,
      evidence,
      httpId,
    });
  };
  if (form.has("z0") && (form.has("z1") || hasEvalDecode))
    add("Caidao", "medium", ["z0 payload parameter", form.has("z1") ? "z1 companion parameter" : "eval/base64_decode wrapper"]);
  if (!form.has("z0") && (/(?:asoutput|asenc)\s*\(/i.test(code) || (hasEvalDecode && (form.has("ant") || /\b(?:function_exists|get_magic_quotes_gpc)\s*\(/i.test(code)))))
    add("AntSword", "medium", ["Customizable POST parameter", "AntSword-compatible code/encoder pattern"]);
  if (scriptEndpoint && response && opaqueCipher(request.body) && opaqueCipher(response.body))
    add("Behinder", "low", [
      "Opaque or Base64-wrapped request and response bodies on a script endpoint",
      "Encryption-like traffic is not enough to confirm a specific client",
    ]);
  return findings;
}

function addDnsName(payload: Buffer, names: Map<string, Set<string>>): void {
  if (payload.length < 12) return;
  const count = payload.readUInt16BE(4);
  const answerCount = payload.readUInt16BE(6);
  if (count !== 1 || answerCount > 20) return;
  let offset = 12;
  const labels: string[] = [];
  for (let i = 0; i < 30 && offset < payload.length; i++) {
    const length = payload[offset++]!;
    if (length === 0) break;
    if (length > 63 || offset + length > payload.length) return;
    labels.push(payload.toString("ascii", offset, offset + length));
    offset += length;
  }
  if (!labels.length || offset + 4 > payload.length) return;
  const name = labels.join(".").slice(0, 150);
  offset += 4;
  for (let i = 0; i < answerCount && offset + 12 <= payload.length; i++) {
    if ((payload[offset]! & 0xc0) === 0xc0) offset += 2;
    else return;
    const type = payload.readUInt16BE(offset);
    const length = payload.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > payload.length) return;
    if (type === 1 && length === 4) {
      const address = ipv4(payload, offset);
      if (!names.has(address) && names.size < MAX_ASSETS) names.set(address, new Set());
      names.get(address)?.add(name);
    }
    offset += length;
  }
}

export function analyzePcap(
  bytes: Buffer,
  name = "capture.pcap",
  keyLogBytes?: Buffer,
): { report: PcapReport; files: ExtractedFile[] } {
  const keyLog = keyLogBytes ? parseTlsKeyLog(keyLogBytes) : undefined;
  const capture = readPcap(bytes);
  const assets = new Map<string, PcapAsset>();
  const links = new Map<string, PcapLink>();
  const directions = new Map<string, Direction>();
  const names = new Map<string, Set<string>>();
  const warnings = [...capture.warnings];
  const http: PcapHttp[] = [];
  const credentials: PcapCredential[] = [];
  const webshells: PcapWebshell[] = [];
  const files: ExtractedFile[] = [];
  let totalStreamBytes = 0;
  let encryptedStreams = 0;
  let decryptedStreams = 0;
  for (const [index, packet] of capture.packets.entries()) {
    const decoded = decodePacket(packet);
    if (!decoded) continue;
    const { source, target, sourcePort, targetPort, protocol, payload } = decoded;
    for (const address of [source, target])
      if (!assets.has(address) && assets.size < MAX_ASSETS)
        assets.set(address, { address, names: [], sent: 0, received: 0, protocols: [] });
    const src = assets.get(source);
    const dst = assets.get(target);
    if (src) {
      src.sent += packet.bytes.length;
      if (!src.protocols.includes(protocol)) src.protocols.push(protocol);
    }
    if (dst) {
      dst.received += packet.bytes.length;
      if (!dst.protocols.includes(protocol)) dst.protocols.push(protocol);
    }
    const linkKey = `${source}\0${target}\0${protocol}`;
    if (!links.has(linkKey) && links.size < MAX_LINKS)
      links.set(linkKey, { source, target, protocol, packets: 0, bytes: 0, ports: [] });
    const link = links.get(linkKey);
    if (link) {
      link.packets++;
      link.bytes += packet.bytes.length;
      if (targetPort && link.ports.length < 8 && !link.ports.includes(targetPort))
        link.ports.push(targetPort);
    }
    if (protocol === "UDP" && (sourcePort === 53 || targetPort === 53)) addDnsName(payload, names);
    if (protocol !== "TCP" || !payload.length) continue;
    const key = `${source}\0${sourcePort}\0${target}\0${targetPort}`;
    if (!directions.has(key))
      directions.set(key, {
        source,
        target,
        sourcePort,
        targetPort,
        segments: [],
        size: 0,
        firstPacket: index,
      });
    const direction = directions.get(key)!;
    if (
      direction.size + payload.length > MAX_STREAM_BYTES ||
      totalStreamBytes + payload.length > MAX_TOTAL_STREAM_BYTES
    ) {
      if (!warnings.includes("TCP reassembly budget reached; some content is omitted"))
        warnings.push("TCP reassembly budget reached; some content is omitted");
      continue;
    }
    direction.segments.push({ sequence: decoded.sequence!, bytes: payload });
    direction.size += payload.length;
    totalStreamBytes += payload.length;
  }
  const streamMessages = new Map<string, HttpMessage[]>();
  const streamBytes = new Map<string, Buffer>();
  for (const [key, direction] of directions) {
    const content = reassemble(direction.segments);
    streamBytes.set(key, content);
    if (
      content.length > 4 &&
      (content[0] === 0x16 || content[0] === 0x17) &&
      content[1] === 0x03 &&
      content[2]! <= 0x04
    )
      encryptedStreams++;
    const messages = httpMessages(content);
    if (messages.length) streamMessages.set(key, messages);
    if (direction.targetPort === 21 && /^USER\s+/im.test(content.toString("latin1", 0, 1000))) {
      const text = content.toString("latin1", 0, 1000);
      const user = /^USER\s+([^\r\n]+)/im.exec(text)?.[1];
      const pass = /^PASS\s+([^\r\n]+)/im.exec(text)?.[1];
      if (pass)
        credentials.push({
          id: `cred-ftp-${credentials.length}`,
          kind: "FTP cleartext",
          source: direction.source,
          target: direction.target,
          username: user,
          value: pass,
          evidence: "FTP USER/PASS commands",
        });
    }
  }
  if (keyLog) {
    for (const [key, direction] of directions) {
      const reverseKey = `${direction.target}\0${direction.targetPort}\0${direction.source}\0${direction.sourcePort}`;
      const reverse = streamBytes.get(reverseKey);
      if (!reverse) continue;
      const result = decryptTlsConversation(streamBytes.get(key)!, reverse, keyLog);
      if (result.client.length) {
        decryptedStreams++;
        const messages = httpMessages(result.client);
        if (messages.length) streamMessages.set(key, messages);
      }
      if (result.server.length) {
        decryptedStreams++;
        const messages = httpMessages(result.server);
        if (messages.length) streamMessages.set(reverseKey, messages);
      }
    }
    if (encryptedStreams && !decryptedStreams)
      warnings.push(
        "No TLS records were decrypted with the supplied key log; check matching secrets and cipher support",
      );
  }
  for (const [key, requests] of streamMessages) {
    const direction = directions.get(key)!;
    const reverseKey = `${direction.target}\0${direction.targetPort}\0${direction.source}\0${direction.sourcePort}`;
    const responses = streamMessages.get(reverseKey) ?? [];
    for (const [requestIndex, request] of requests.entries()) {
      const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+) HTTP\/1\.[01]$/.exec(request.start);
      if (!match || http.length >= MAX_HTTP) continue;
      const response = responses[requestIndex];
      const id = `http-${http.length + 1}`;
      const path = match[2]!;
      const host = (
        request.headers.host ??
        names.get(direction.target)?.values().next().value ??
        direction.target
      ).slice(0, 180);
      const status = response
        ? Number(/^HTTP\/1\.[01] (\d{3})/.exec(response.start)?.[1]) || undefined
        : undefined;
      const item: PcapHttp = {
        id,
        source: direction.source,
        target: direction.target,
        port: direction.targetPort,
        method: match[1]!,
        path: path.slice(0, 300),
        host,
        status,
        contentType: response?.headers["content-type"]?.slice(0, 120),
        requestPreview: preview(request.body),
        responsePreview: response && preview(response.body),
        requestRaw: request.body.subarray(0, 8_192).toString("utf8"),
        responseRaw: response?.body.subarray(0, 8_192).toString("utf8"),
        fileIds: [],
      };
      http.push(item);
      if (!names.has(direction.target)) names.set(direction.target, new Set());
      names.get(direction.target)!.add(host);
      const authorization = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization ?? "");
      if (authorization) {
        const decoded = Buffer.from(authorization[1]!, "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon > 0 && colon < 120 && decoded.length < 512)
          credentials.push({
            id: `cred-basic-${credentials.length}`,
            kind: "HTTP Basic",
            source: direction.source,
            target: direction.target,
            username: decoded.slice(0, colon),
            value: decoded.slice(colon + 1),
            evidence: `${match[1]} ${path.slice(0, 100)}`,
          });
      }
      if (
        (request.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded") &&
        request.body.length < 64_000
      ) {
        const form = new URLSearchParams(request.body.toString("utf8"));
        const username = form.get("username") ?? form.get("user") ?? form.get("login") ?? undefined;
        for (const [field, value] of form)
          if (/^(password|passwd|pwd|pass)$/i.test(field) && value.length < 512)
            credentials.push({
              id: `cred-form-${credentials.length}`,
              kind: "HTTP form cleartext",
              source: direction.source,
              target: direction.target,
              username,
              value,
              evidence: `${field} in ${match[1]} ${path.slice(0, 100)}`,
            });
      }
      webshells.push(...detectWebshell(request, response, direction.source, direction.target, path, id));
      if (response?.body.length && response.body.length <= MAX_FILE_BYTES && files.length < MAX_FILES) {
        const disposition = /filename\*?\s*=\s*([^;]+)/i.exec(
          response.headers["content-disposition"] ?? "",
        )?.[1];
        const mediaType = (response.headers["content-type"] ?? "application/octet-stream")
          .split(";", 1)[0]!
          .trim();
        const binaryType = !/^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded))/.test(
          mediaType,
        );
        if (disposition || binaryType) {
          const fileId = `file-${files.length + 1}`;
          const name = safeName(
            disposition ?? path.split("?", 1)[0]?.split("/").at(-1) ?? `object-${files.length + 1}.bin`,
          );
          files.push({
            id: fileId,
            name,
            mediaType,
            bytes: response.body,
            source: direction.target,
            httpId: id,
          });
          item.fileIds.push(fileId);
        }
      }
    }
  }
  for (const [key, messages] of streamMessages)
    for (const message of messages) {
      if (
        !/^HTTP\/1\.[01] \d{3}\b/.test(message.start) ||
        !message.body.length ||
        message.body.length > MAX_FILE_BYTES ||
        files.length >= MAX_FILES
      )
        continue;
      const direction = directions.get(key)!;
      const reverseKey = `${direction.target}\0${direction.targetPort}\0${direction.source}\0${direction.sourcePort}`;
      if (
        streamMessages
          .get(reverseKey)
          ?.some((item) => /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(item.start))
      )
        continue;
      const disposition = /filename\*?\s*=\s*([^;]+)/i.exec(
        message.headers["content-disposition"] ?? "",
      )?.[1];
      const mediaType = (message.headers["content-type"] ?? "application/octet-stream")
        .split(";", 1)[0]!
        .trim();
      if (
        !disposition &&
        /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded))/.test(mediaType)
      )
        continue;
      files.push({
        id: `file-${files.length + 1}`,
        name: safeName(disposition ?? `object-${files.length + 1}.bin`),
        mediaType,
        bytes: message.body,
        source: direction.source,
        httpId: "",
      });
    }
  for (const asset of assets.values()) asset.names = [...(names.get(asset.address) ?? [])].slice(0, 5);
  if (capture.truncated)
    warnings.push("Capture stopped at the packet limit or ended with an incomplete packet header");
  if (encryptedStreams && decryptedStreams < encryptedStreams)
    warnings.push(
      "Some TLS payloads remain encrypted; matching session secrets and a supported cipher are required",
    );
  const report: PcapReport = {
    id: "",
    projectId: "",
    name: safeName(name),
    createdAt: Date.now(),
    format: capture.format,
    packetCount: capture.packets.length,
    byteCount: bytes.length,
    truncated: capture.truncated,
    encryptedStreams,
    decryptedStreams,
    decryption: {
      status: !encryptedStreams
        ? "not-needed"
        : !decryptedStreams
          ? "key-required"
          : decryptedStreams < encryptedStreams
            ? "partial"
            : "decrypted",
      explanation: !encryptedStreams
        ? "Unencrypted protocol data was decoded where supported; HTTP Basic is encoding, not encryption."
        : !decryptedStreams
          ? "TLS payloads remain encrypted. Import a matching TLS key log to decrypt supported sessions."
          : decryptedStreams < encryptedStreams
            ? "Some supported TLS application records decrypted; other traffic remains encrypted or unsupported."
            : "Supported TLS application records decrypted with the imported key log. HTTP/1.x content was analyzed where present.",
    },
    assets: [...assets.values()],
    links: [...links.values()],
    http,
    credentials: credentials.slice(0, 200),
    webshells: webshells.slice(0, 200),
    files: files.map(({ id, name, mediaType, bytes: content, source, httpId }) => ({
      id,
      name,
      mediaType,
      size: content.length,
      source,
      httpId,
    })),
    warnings,
  };
  return { report, files };
}

export function enrichPcapReport(report: PcapReport, rows: TsharkHttpRow[]): void {
  const byFrame = new Map(rows.map((row) => [row.frame, row]));
  const matched = new Set<string>();
  for (const row of rows) {
    if (!row.method || !row.path || !/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(row.method))
      continue;
    const response = row.responseFrame ? byFrame.get(row.responseFrame) : rows.find(
      (candidate) => candidate.requestFrame === row.frame && candidate.stream === row.stream,
    );
    let item = report.http.find((current) =>
      !matched.has(current.id) &&
      current.source === row.source && current.target === row.target &&
      current.port === row.targetPort && current.method === row.method && current.path === row.path,
    );
    if (!item) {
      if (report.http.length >= MAX_HTTP) continue;
      item = {
        id: `http-${report.http.length + 1}`,
        source: row.source,
        target: row.target,
        port: row.targetPort,
        method: row.method,
        path: row.path,
        host: row.host ?? row.target,
        status: response?.status,
        contentType: response?.contentType,
        requestPreview: preview(row.body),
        responsePreview: response ? preview(response.body) : undefined,
        requestRaw: row.body.subarray(0, 8_192).toString("utf8"),
        responseRaw: response?.body.subarray(0, 8_192).toString("utf8"),
        fileIds: [],
      };
      report.http.push(item);
    } else {
      if (!item.requestRaw && row.body.length) {
        item.requestPreview = preview(row.body);
        item.requestRaw = row.body.subarray(0, 8_192).toString("utf8");
      }
      if (!item.status && response?.status) item.status = response.status;
      if (!item.responseRaw && response?.body.length) {
        item.responsePreview = preview(response.body);
        item.responseRaw = response.body.subarray(0, 8_192).toString("utf8");
      }
    }
    matched.add(item.id);
    const requestMessage: HttpMessage = {
      start: `${row.method} ${row.path} HTTP/1.1`,
      headers: { "content-type": row.contentType ?? "" },
      body: row.body,
    };
    const responseMessage: HttpMessage | undefined = response ? {
      start: `HTTP/1.1 ${response.status ?? 200}`,
      headers: { "content-type": response.contentType ?? "" },
      body: response.body,
    } : undefined;
    for (const clue of detectWebshell(requestMessage, responseMessage, row.source, row.target, row.path, item.id))
      if (report.webshells.length < 200 && !report.webshells.some((current) => current.id === clue.id))
        report.webshells.push(clue);
  }
}

export function buildPcapAgentEvidence(report: PcapReport, selection: string, includeRaw: boolean): string {
  const metadata = {
    capture: report.name,
    packets: report.packetCount,
    encryptedStreams: report.encryptedStreams,
    decryption: report.decryption.status,
  };
  if (selection === "overview")
    return JSON.stringify({
      ...metadata,
      assets: report.assets.slice(0, 40),
      links: report.links.slice(0, 80),
      webshells: report.webshells.slice(0, 30),
      files: report.files.slice(0, 30),
      credentials: report.credentials.slice(0, 20).map(({ value: _value, ...safe }) => safe),
      warnings: report.warnings,
    }).slice(0, 10_000);
  const http = report.http.find((item) => item.id === selection);
  if (http) {
    const {
      requestRaw,
      responseRaw,
      requestPreview: _requestPreview,
      responsePreview: _responsePreview,
      ...safe
    } = http;
    return JSON.stringify({
      ...metadata,
      selected: includeRaw ? { ...safe, requestRaw, responseRaw } : safe,
    }).slice(0, 10_000);
  }
  const credential = report.credentials.find((item) => item.id === selection);
  if (credential) {
    const { value, ...safe } = credential;
    return JSON.stringify({ ...metadata, selected: includeRaw ? { ...safe, value } : safe }).slice(0, 10_000);
  }
  const selected =
    report.webshells.find((item) => item.id === selection) ??
    report.assets.find((item) => item.address === selection) ??
    report.files.find((item) => item.id === selection) ??
    report.links.find((item) => `${item.source}->${item.target}` === selection);
  if (!selected) throw new Error("PCAP evidence selection not found");
  return JSON.stringify({ ...metadata, selected }).slice(0, 10_000);
}
