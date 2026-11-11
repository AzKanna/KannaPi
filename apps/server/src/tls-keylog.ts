import { createDecipheriv, createHmac, type DecipherGCM } from "node:crypto";

export type TlsKeyLog = Map<string, Buffer>;

interface TlsRecord {
  type: number;
  header: Buffer;
  payload: Buffer;
}
interface CipherSpec {
  algorithm: "aes-128-gcm" | "aes-256-gcm" | "chacha20-poly1305";
  keyLength: number;
  hash: "sha256" | "sha384";
}

const TLS13_CIPHERS: Record<number, CipherSpec> = {
  0x1301: { algorithm: "aes-128-gcm", keyLength: 16, hash: "sha256" },
  0x1302: { algorithm: "aes-256-gcm", keyLength: 32, hash: "sha384" },
  0x1303: { algorithm: "chacha20-poly1305", keyLength: 32, hash: "sha256" },
};
const TLS12_CIPHERS: Record<number, CipherSpec> = {
  0x009c: { algorithm: "aes-128-gcm", keyLength: 16, hash: "sha256" },
  0x009d: { algorithm: "aes-256-gcm", keyLength: 32, hash: "sha384" },
  0xc02b: { algorithm: "aes-128-gcm", keyLength: 16, hash: "sha256" },
  0xc02c: { algorithm: "aes-256-gcm", keyLength: 32, hash: "sha384" },
  0xc02f: { algorithm: "aes-128-gcm", keyLength: 16, hash: "sha256" },
  0xc030: { algorithm: "aes-256-gcm", keyLength: 32, hash: "sha384" },
};

export function parseTlsKeyLog(bytes: Buffer): TlsKeyLog {
  if (!bytes.length || bytes.length > 1024 * 1024)
    throw new Error("TLS key log must be between 1 byte and 1 MiB");
  const lines = bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  if (lines.length > 10_000) throw new Error("TLS key log has too many lines");
  const secrets: TlsKeyLog = new Map();
  for (const line of lines) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s+([0-9a-fA-F]{64})\s+([0-9a-fA-F]{64,128})$/.exec(value);
    if (!match || match[3]!.length % 2) throw new Error("Invalid TLS key log line");
    if (
      !/^(?:CLIENT_RANDOM|(?:CLIENT|SERVER)_(?:HANDSHAKE_TRAFFIC_SECRET|TRAFFIC_SECRET_0))$/.test(match[1]!)
    )
      continue;
    secrets.set(`${match[1]}:${match[2]!.toLowerCase()}`, Buffer.from(match[3]!, "hex"));
  }
  if (!secrets.size) throw new Error("TLS key log contains no supported session secrets");
  return secrets;
}

function records(bytes: Buffer): TlsRecord[] {
  const found: TlsRecord[] = [];
  let offset = 0;
  while (offset + 5 <= bytes.length && found.length < 4096) {
    const size = bytes.readUInt16BE(offset + 3);
    if (![20, 21, 22, 23].includes(bytes[offset]!) || size > 18_432 || offset + size + 5 > bytes.length)
      break;
    found.push({
      type: bytes[offset]!,
      header: bytes.subarray(offset, offset + 5),
      payload: bytes.subarray(offset + 5, offset + 5 + size),
    });
    offset += size + 5;
  }
  return found;
}

function hello(recordList: TlsRecord[], type: 1 | 2): Buffer | undefined {
  for (const record of recordList) {
    if (record.type !== 22 || record.payload.length < 4) continue;
    const length = record.payload.readUIntBE(1, 3);
    if (record.payload[0] === type && length >= 34 && length + 4 <= record.payload.length)
      return record.payload.subarray(4, length + 4);
  }
  return undefined;
}

function cipherSuite(serverHello: Buffer): number | undefined {
  const sessionLength = serverHello[34];
  if (sessionLength === undefined || serverHello.length < 37 + sessionLength) return;
  return serverHello.readUInt16BE(35 + sessionLength);
}

function expandLabel(secret: Buffer, hash: "sha256" | "sha384", label: string, length: number): Buffer {
  const name = Buffer.from(`tls13 ${label}`, "ascii");
  const info = Buffer.concat([Buffer.from([length >> 8, length & 255, name.length]), name, Buffer.from([0])]);
  const chunks: Buffer[] = [];
  let prior = Buffer.alloc(0);
  while (Buffer.concat(chunks).length < length) {
    prior = createHmac(hash, secret)
      .update(prior)
      .update(info)
      .update(Buffer.from([chunks.length + 1]))
      .digest();
    chunks.push(prior);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function decryptRecord(
  record: TlsRecord,
  key: Buffer,
  iv: Buffer,
  spec: CipherSpec,
  sequence: number,
): { type: number; bytes: Buffer } | undefined {
  if (record.type !== 23 || record.payload.length < 17) return;
  const nonce = Buffer.from(iv);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(sequence));
  for (let index = 0; index < 8; index++) nonce[4 + index] = nonce[4 + index]! ^ counter[index]!;
  try {
    const decipher = createDecipheriv(spec.algorithm, key, nonce) as DecipherGCM;
    decipher.setAAD(record.header);
    decipher.setAuthTag(record.payload.subarray(-16));
    const plain = Buffer.concat([decipher.update(record.payload.subarray(0, -16)), decipher.final()]);
    let last = plain.length - 1;
    while (last >= 0 && plain[last] === 0) last--;
    if (last < 0 || ![21, 22, 23].includes(plain[last]!)) return;
    return { type: plain[last]!, bytes: plain.subarray(0, last) };
  } catch {
    return;
  }
}

function decodeDirection(
  recordList: TlsRecord[],
  random: string,
  side: "CLIENT" | "SERVER",
  spec: CipherSpec,
  secrets: TlsKeyLog,
): { bytes: Buffer; records: number } {
  const appSecret = secrets.get(`${side}_TRAFFIC_SECRET_0:${random}`);
  const handshakeSecret = secrets.get(`${side}_HANDSHAKE_TRAFFIC_SECRET:${random}`);
  const app = appSecret && {
    key: expandLabel(appSecret, spec.hash, "key", spec.keyLength),
    iv: expandLabel(appSecret, spec.hash, "iv", 12),
    sequence: 0,
  };
  const handshake = handshakeSecret && {
    key: expandLabel(handshakeSecret, spec.hash, "key", spec.keyLength),
    iv: expandLabel(handshakeSecret, spec.hash, "iv", 12),
    sequence: 0,
  };
  const parts: Buffer[] = [];
  let decryptedRecords = 0;
  let applicationStarted = false;
  for (const record of recordList) {
    if (record.type !== 23) continue;
    const appPlain = app && decryptRecord(record, app.key, app.iv, spec, app.sequence);
    if (appPlain) {
      app.sequence++;
      applicationStarted = true;
      decryptedRecords++;
      if (appPlain.type === 23) parts.push(appPlain.bytes);
      continue;
    }
    if (applicationStarted || !handshake) continue;
    const handshakePlain = decryptRecord(record, handshake.key, handshake.iv, spec, handshake.sequence);
    if (handshakePlain) {
      handshake.sequence++;
      decryptedRecords++;
    }
  }
  return { bytes: Buffer.concat(parts), records: decryptedRecords };
}

function tls12Prf(secret: Buffer, seed: Buffer, hash: "sha256" | "sha384", length: number): Buffer {
  const parts: Buffer[] = [];
  let a = createHmac(hash, secret).update(seed).digest();
  let size = 0;
  while (size < length) {
    const part = createHmac(hash, secret).update(a).update(seed).digest();
    parts.push(part);
    size += part.length;
    a = createHmac(hash, secret).update(a).digest();
  }
  return Buffer.concat(parts).subarray(0, length);
}

function decodeTls12Direction(
  recordList: TlsRecord[],
  key: Buffer,
  fixedIv: Buffer,
  spec: CipherSpec,
): { bytes: Buffer; records: number } {
  const parts: Buffer[] = [];
  let sequence = 0;
  let encrypted = false;
  let authenticated = 0;
  for (const record of recordList) {
    if (record.type === 20) {
      encrypted = true;
      continue;
    }
    if (!encrypted || ![21, 22, 23].includes(record.type) || record.payload.length < 24) continue;
    const nonce = Buffer.concat([fixedIv, record.payload.subarray(0, 8)]);
    const plainLength = record.payload.length - 24;
    const aad = Buffer.alloc(13);
    aad.writeBigUInt64BE(BigInt(sequence));
    aad[8] = record.type;
    record.header.copy(aad, 9, 1, 3);
    aad.writeUInt16BE(plainLength, 11);
    sequence++;
    try {
      const decipher = createDecipheriv(spec.algorithm, key, nonce) as DecipherGCM;
      decipher.setAAD(aad);
      decipher.setAuthTag(record.payload.subarray(-16));
      const plain = Buffer.concat([decipher.update(record.payload.subarray(8, -16)), decipher.final()]);
      authenticated++;
      if (record.type === 23) parts.push(plain);
    } catch {
      // An unauthenticated record is never reported as decrypted plaintext.
    }
  }
  return { bytes: Buffer.concat(parts), records: authenticated };
}

export interface DecryptedTlsConversation {
  client: Buffer;
  server: Buffer;
  decryptedRecords: number;
  cipher?: string;
}

/** Offline-only TLS 1.2/1.3 AEAD application-data decoding; never contacts a capture interface or network endpoint. */
export function decryptTlsConversation(
  clientBytes: Buffer,
  serverBytes: Buffer,
  secrets: TlsKeyLog,
): DecryptedTlsConversation {
  const clientRecords = records(clientBytes);
  const serverRecords = records(serverBytes);
  const clientHello = hello(clientRecords, 1);
  const serverHello = hello(serverRecords, 2);
  if (!clientHello || !serverHello)
    return { client: Buffer.alloc(0), server: Buffer.alloc(0), decryptedRecords: 0 };
  const random = clientHello.subarray(2, 34).toString("hex");
  const suite = cipherSuite(serverHello);
  if (suite === undefined) return { client: Buffer.alloc(0), server: Buffer.alloc(0), decryptedRecords: 0 };
  const tls13 = TLS13_CIPHERS[suite];
  if (tls13) {
    const client = decodeDirection(clientRecords, random, "CLIENT", tls13, secrets);
    const server = decodeDirection(serverRecords, random, "SERVER", tls13, secrets);
    return {
      client: client.bytes,
      server: server.bytes,
      decryptedRecords: client.records + server.records,
      cipher: tls13.algorithm,
    };
  }
  const tls12 = TLS12_CIPHERS[suite];
  const master = secrets.get(`CLIENT_RANDOM:${random}`);
  if (!tls12 || !master || master.length !== 48)
    return { client: Buffer.alloc(0), server: Buffer.alloc(0), decryptedRecords: 0 };
  const seed = Buffer.concat([
    Buffer.from("key expansion"),
    serverHello.subarray(2, 34),
    clientHello.subarray(2, 34),
  ]);
  const block = tls12Prf(master, seed, tls12.hash, tls12.keyLength * 2 + 8);
  const client = decodeTls12Direction(
    clientRecords,
    block.subarray(0, tls12.keyLength),
    block.subarray(tls12.keyLength * 2, tls12.keyLength * 2 + 4),
    tls12,
  );
  const server = decodeTls12Direction(
    serverRecords,
    block.subarray(tls12.keyLength, tls12.keyLength * 2),
    block.subarray(tls12.keyLength * 2 + 4, tls12.keyLength * 2 + 8),
    tls12,
  );
  return {
    client: client.bytes,
    server: server.bytes,
    decryptedRecords: client.records + server.records,
    cipher: tls12.algorithm,
  };
}
