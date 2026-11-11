import { type CipherGCM, createCipheriv, createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { analyzePcap, buildPcapAgentEvidence, enrichPcapReport } from "./pcap-analysis.js";
import { parseTlsKeyLog } from "./tls-keylog.js";

function tcpFrame(
  source: number[],
  target: number[],
  sourcePort: number,
  targetPort: number,
  sequence: number,
  payload: Buffer,
): Buffer {
  const frame = Buffer.alloc(14 + 20 + 20 + payload.length);
  frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45;
  frame.writeUInt16BE(40 + payload.length, 16);
  frame[22] = 64;
  frame[23] = 6;
  Buffer.from(source).copy(frame, 26);
  Buffer.from(target).copy(frame, 30);
  frame.writeUInt16BE(sourcePort, 34);
  frame.writeUInt16BE(targetPort, 36);
  frame.writeUInt32BE(sequence, 38);
  frame[46] = 0x50;
  frame[47] = 0x18;
  payload.copy(frame, 54);
  return frame;
}

function pcap(...frames: Buffer[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(1, 20);
  const packets = frames.map((frame, index) => {
    const packet = Buffer.alloc(16);
    packet.writeUInt32LE(1_700_000_000 + index, 0);
    packet.writeUInt32LE(frame.length, 8);
    packet.writeUInt32LE(frame.length, 12);
    return Buffer.concat([packet, frame]);
  });
  return Buffer.concat([header, ...packets]);
}

function pcapng(frame: Buffer): Buffer {
  const section = Buffer.from("0a0d0d0a1c0000004d3c2b1a01000000ffffffffffffffff1c000000", "hex");
  const iface = Buffer.from("0100000014000000010000000000000014000000", "hex");
  const padded = Buffer.alloc(Math.ceil(frame.length / 4) * 4);
  frame.copy(padded);
  const block = Buffer.alloc(32 + padded.length);
  block.writeUInt32LE(6, 0);
  block.writeUInt32LE(block.length, 4);
  block.writeUInt32LE(0, 8);
  block.writeUInt32LE(1_700_000_000, 16);
  block.writeUInt32LE(frame.length, 20);
  padded.copy(block, 28);
  block.writeUInt32LE(block.length, block.length - 4);
  return Buffer.concat([section, iface, block]);
}

const client = [10, 0, 0, 4];
const server = [10, 0, 0, 9];

function tlsRecord(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt16BE(0x0303, 1);
  header.writeUInt16BE(payload.length, 3);
  return Buffer.concat([header, payload]);
}

function tls13Fixture(suite: 0x1301 | 0x1302 | 0x1303 = 0x1301): {
  capture: Buffer;
  keyLog: Buffer;
  wrongKeyLog: Buffer;
} {
  const spec =
    suite === 0x1302
      ? { algorithm: "aes-256-gcm" as const, keyLength: 32, hash: "sha384" as const, secretLength: 48 }
      : suite === 0x1303
        ? {
            algorithm: "chacha20-poly1305" as const,
            keyLength: 32,
            hash: "sha256" as const,
            secretLength: 32,
          }
        : { algorithm: "aes-128-gcm" as const, keyLength: 16, hash: "sha256" as const, secretLength: 32 };
  const random = Buffer.alloc(32, 0x72);
  const clientSecret = Buffer.alloc(spec.secretLength, 0x21);
  const serverSecret = Buffer.alloc(spec.secretLength, 0x34);
  const expand = (secret: Buffer, label: string, size: number): Buffer => {
    const name = Buffer.from(`tls13 ${label}`);
    const info = Buffer.concat([Buffer.from([0, size, name.length]), name, Buffer.from([0])]);
    return createHmac(spec.hash, secret)
      .update(info)
      .update(Buffer.from([1]))
      .digest()
      .subarray(0, size);
  };
  const encrypted = (plain: string, secret: Buffer): Buffer => {
    const key = expand(secret, "key", spec.keyLength);
    const iv = expand(secret, "iv", 12);
    const data = Buffer.concat([Buffer.from(plain), Buffer.from([23])]);
    const header = Buffer.from([23, 3, 3, (data.length + 16) >> 8, (data.length + 16) & 255]);
    const cipher = createCipheriv(spec.algorithm, key, iv) as CipherGCM;
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  };
  const clientHello = Buffer.alloc(34);
  clientHello.writeUInt16BE(0x0303, 0);
  random.copy(clientHello, 2);
  const serverHello = Buffer.alloc(38);
  serverHello.writeUInt16BE(0x0303, 0);
  Buffer.alloc(32, 0x16).copy(serverHello, 2);
  serverHello.writeUInt16BE(suite, 35);
  const handshake = (type: number, body: Buffer) =>
    Buffer.concat([Buffer.from([type, 0, 0, body.length]), body]);
  const ch = tlsRecord(22, handshake(1, clientHello));
  const sh = tlsRecord(22, handshake(2, serverHello));
  const authorization = Buffer.from("alice:tls-password").toString("base64");
  const request = encrypted(
    `GET /secure HTTP/1.1\r\nHost: lab.local\r\nAuthorization: Basic ${authorization}\r\n\r\n`,
    clientSecret,
  );
  const response = encrypted(
    "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 5\r\n\r\nhello",
    serverSecret,
  );
  return {
    capture: pcap(
      tcpFrame(client, server, 52000, 443, 1, ch),
      tcpFrame(server, client, 443, 52000, 1, sh),
      tcpFrame(client, server, 52000, 443, 1 + ch.length, request),
      tcpFrame(server, client, 443, 52000, 1 + sh.length, response),
    ),
    keyLog: Buffer.from(
      `CLIENT_TRAFFIC_SECRET_0 ${random.toString("hex")} ${clientSecret.toString("hex")}\nSERVER_TRAFFIC_SECRET_0 ${random.toString("hex")} ${serverSecret.toString("hex")}\n`,
    ),
    wrongKeyLog: Buffer.from(
      `CLIENT_TRAFFIC_SECRET_0 ${random.toString("hex")} ${Buffer.alloc(spec.secretLength, 0x55).toString("hex")}\n`,
    ),
  };
}

function tls12Fixture(suite: 0xc02f | 0xc030 = 0xc02f): { capture: Buffer; keyLog: Buffer } {
  const keyLength = suite === 0xc030 ? 32 : 16;
  const algorithm = suite === 0xc030 ? "aes-256-gcm" : "aes-128-gcm";
  const hash = suite === 0xc030 ? "sha384" : "sha256";
  const clientRandom = Buffer.alloc(32, 0x41);
  const serverRandom = Buffer.alloc(32, 0x52);
  const master = Buffer.alloc(48, 0x63);
  const seed = Buffer.concat([Buffer.from("key expansion"), serverRandom, clientRandom]);
  let a = createHmac(hash, master).update(seed).digest();
  const blocks: Buffer[] = [];
  while (Buffer.concat(blocks).length < keyLength * 2 + 8) {
    blocks.push(createHmac(hash, master).update(a).update(seed).digest());
    a = createHmac(hash, master).update(a).digest();
  }
  const keyBlock = Buffer.concat(blocks);
  const encrypt = (plain: string, key: Buffer, fixedIv: Buffer, sequence: number, type: number): Buffer => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(sequence));
    const aad = Buffer.alloc(13);
    counter.copy(aad);
    aad[8] = type;
    aad.writeUInt16BE(0x0303, 9);
    aad.writeUInt16BE(Buffer.byteLength(plain), 11);
    const cipher = createCipheriv(algorithm, key, Buffer.concat([fixedIv, counter]));
    cipher.setAAD(aad);
    return tlsRecord(
      type,
      Buffer.concat([counter, cipher.update(plain), cipher.final(), cipher.getAuthTag()]),
    );
  };
  const clientHello = Buffer.alloc(34);
  clientHello.writeUInt16BE(0x0303, 0);
  clientRandom.copy(clientHello, 2);
  const serverHello = Buffer.alloc(38);
  serverHello.writeUInt16BE(0x0303, 0);
  serverRandom.copy(serverHello, 2);
  serverHello.writeUInt16BE(suite, 35);
  const handshake = (type: number, body: Buffer) =>
    tlsRecord(22, Buffer.concat([Buffer.from([type, 0, 0, body.length]), body]));
  const ch = handshake(1, clientHello);
  const sh = handshake(2, serverHello);
  const ccs = tlsRecord(20, Buffer.from([1]));
  const clientKey = keyBlock.subarray(0, keyLength);
  const serverKey = keyBlock.subarray(keyLength, keyLength * 2);
  const clientIv = keyBlock.subarray(keyLength * 2, keyLength * 2 + 4);
  const serverIv = keyBlock.subarray(keyLength * 2 + 4, keyLength * 2 + 8);
  const clientFinished = encrypt("finished", clientKey, clientIv, 0, 22);
  const serverFinished = encrypt("finished", serverKey, serverIv, 0, 22);
  const request = encrypt("GET /tls12 HTTP/1.1\r\nHost: lab.local\r\n\r\n", clientKey, clientIv, 1, 23);
  const response = encrypt("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", serverKey, serverIv, 1, 23);
  return {
    capture: pcap(
      tcpFrame(client, server, 52001, 443, 1, Buffer.concat([ch, ccs, clientFinished, request])),
      tcpFrame(server, client, 443, 52001, 1, Buffer.concat([sh, ccs, serverFinished, response])),
    ),
    keyLog: Buffer.from(`CLIENT_RANDOM ${clientRandom.toString("hex")} ${master.toString("hex")}\n`),
  };
}

describe("offline PCAP analysis", () => {
  test("decrypts matching TLS 1.3 AES-GCM HTTP with a key log and reuses existing analysis", () => {
    const fixture = tls13Fixture();
    const result = analyzePcap(fixture.capture, "tls.pcap", fixture.keyLog);
    expect(result.report.decryption.status).toBe("decrypted");
    expect(result.report.http[0]).toMatchObject({ method: "GET", path: "/secure", status: 200 });
    expect(result.report.credentials[0]).toMatchObject({ kind: "HTTP Basic", value: "tls-password" });
    expect(result.files[0]?.bytes.toString()).toBe("hello");
  });

  test.each([0x1302, 0x1303] as const)("decrypts TLS 1.3 cipher suite 0x%s", (suite) => {
    const fixture = tls13Fixture(suite);
    const report = analyzePcap(fixture.capture, "tls.pcap", fixture.keyLog).report;
    expect(report.decryption.status).toBe("decrypted");
    expect(report.http[0]?.path).toBe("/secure");
  });

  test("does not claim decryption when TLS secrets do not match", () => {
    const fixture = tls13Fixture();
    const report = analyzePcap(fixture.capture, "tls.pcap", fixture.wrongKeyLog).report;
    expect(report.decryption.status).toBe("key-required");
    expect(report.http).toHaveLength(0);
  });

  test("marks one-sided TLS key logs as partially decrypted", () => {
    const fixture = tls13Fixture();
    const clientOnly = Buffer.from(fixture.keyLog.toString("utf8").split("\n")[0] + "\n");
    const report = analyzePcap(fixture.capture, "tls.pcap", clientOnly).report;
    expect(report.decryption.status).toBe("partial");
    expect(report.http[0]).toMatchObject({ path: "/secure", status: undefined });
  });

  test("rejects malformed or oversized TLS key logs before analysis", () => {
    expect(() => parseTlsKeyLog(Buffer.from("not a key log"))).toThrow(/key log/i);
    expect(() => parseTlsKeyLog(Buffer.alloc(1024 * 1024 + 1))).toThrow(/1 MiB/i);
  });

  test("marks a mid-stream TLS application record as encrypted when the handshake is missing", () => {
    const capture = pcap(tcpFrame(client, server, 52002, 443, 1, tlsRecord(23, Buffer.alloc(32, 0xaa))));
    const report = analyzePcap(capture, "midstream.pcap").report;
    expect(report.encryptedStreams).toBe(1);
    expect(report.decryption.status).toBe("key-required");
  });

  test("decrypts TLS 1.2 AES-GCM after encrypted Finished records", () => {
    const fixture = tls12Fixture();
    const report = analyzePcap(fixture.capture, "tls12.pcap", fixture.keyLog).report;
    expect(report.decryption.status).toBe("decrypted");
    expect(report.http[0]).toMatchObject({ path: "/tls12", status: 200 });
  });

  test("decrypts TLS 1.2 AES-256-GCM SHA-384 sessions", () => {
    const fixture = tls12Fixture(0xc030);
    const report = analyzePcap(fixture.capture, "tls12-256.pcap", fixture.keyLog).report;
    expect(report.decryption.status).toBe("decrypted");
    expect(report.http[0]?.path).toBe("/tls12");
  });
  test("reassembles HTTP, decodes Basic credentials, detects a webshell clue, and exports a response object", () => {
    const authorization = Buffer.from("alice:correct-horse").toString("base64");
    const request = Buffer.from(
      `POST /upload/shell.php HTTP/1.1\r\nHost: lab.local\r\nAuthorization: Basic ${authorization}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 36\r\n\r\nant=eval%28base64_decode%28abc%29%29`,
    );
    const response = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=report.txt\r\nContent-Length: 5\r\n\r\nhello",
    );
    const capture = pcap(
      tcpFrame(client, server, 51000, 80, 1, request.subarray(0, 35)),
      tcpFrame(client, server, 51000, 80, 36, request.subarray(35)),
      tcpFrame(server, client, 80, 51000, 1, response),
    );
    const result = analyzePcap(capture, "sample.pcap");
    expect(result.report.format).toBe("pcap");
    expect(result.report.packetCount).toBe(3);
    expect(result.report.http[0]).toMatchObject({ method: "POST", host: "lab.local", status: 200 });
    expect(result.report.credentials[0]).toMatchObject({
      kind: "HTTP Basic",
      username: "alice",
      value: "correct-horse",
    });
    expect(
      result.report.webshells.some((item) => item.family === "AntSword" && item.confidence !== "high"),
    ).toBe(true);
    expect(result.files[0]).toMatchObject({ name: "report.txt", bytes: Buffer.from("hello") });
    expect(result.report.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "10.0.0.4", target: "10.0.0.9", protocol: "TCP" }),
      ]),
    );
  });

  test("accepts pcapng and records encrypted TLS as needing secrets", () => {
    const tls = Buffer.from("16030300050100000100", "hex");
    const result = analyzePcap(pcapng(tcpFrame(client, server, 51001, 443, 1, tls)), "sample.pcapng");
    expect(result.report.format).toBe("pcapng");
    expect(result.report.encryptedStreams).toBe(1);
    expect(result.report.decryption.status).toBe("key-required");
  });

  test("rejects truncated captures and ignores traversal in exported names", () => {
    expect(() => analyzePcap(Buffer.from("not a capture"), "fake.pcap")).toThrow(/PCAP|capture/i);
    const response = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=../../escape.exe\r\nContent-Length: 2\r\n\r\nOK",
    );
    const result = analyzePcap(pcap(tcpFrame(server, client, 80, 51000, 1, response)), "safe.pcap");
    expect(result.files[0]?.name).toBe("escape.exe");
    expect(result.files[0]?.bytes.toString()).toBe("OK");
  });

  test("keeps secrets and raw bodies out of Agent evidence unless explicitly selected", () => {
    const authorization = Buffer.from("alice:correct-horse").toString("base64");
    const request = Buffer.from(
      `POST /login HTTP/1.1\r\nHost: lab.local\r\nAuthorization: Basic ${authorization}\r\nContent-Length: 18\r\n\r\npassword=sensitive`,
    );
    const report = analyzePcap(pcap(tcpFrame(client, server, 51000, 80, 1, request)), "private.pcap").report;
    const summary = buildPcapAgentEvidence(report, "overview", false);
    expect(summary).not.toContain("correct-horse");
    expect(summary).not.toContain("sensitive");
    const selected = buildPcapAgentEvidence(report, "http-1", true);
    expect(selected).toContain("password=sensitive");
  });

  test("pairs multiple HTTP requests and responses on one TCP connection", () => {
    const first = Buffer.from("GET /one HTTP/1.1\r\nHost: lab.local\r\n\r\n");
    const second = Buffer.from("GET /two HTTP/1.1\r\nHost: lab.local\r\n\r\n");
    const firstResponse = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\none",
    );
    const secondResponse = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\ntwo",
    );
    const report = analyzePcap(
      pcap(
        tcpFrame(client, server, 51002, 80, 1, first),
        tcpFrame(client, server, 51002, 80, first.length + 1, second),
        tcpFrame(server, client, 80, 51002, 1, firstResponse),
        tcpFrame(server, client, 80, 51002, firstResponse.length + 1, secondResponse),
      ),
    ).report;
    expect(report.http.map((item) => [item.path, item.responseRaw])).toEqual([
      ["/one", "one"],
      ["/two", "two"],
    ]);
  });

  test("labels Caidao and Behinder patterns as candidates rather than confirmed attribution", () => {
    const caidaoBody = "z0=QGluaV9zZXQoKTs=&z1=QHN5c3RlbSgnbHMnKTs=";
    const caidao = Buffer.from(
      `POST /admin/a.php HTTP/1.1\r\nHost: lab.local\r\nContent-Length: ${caidaoBody.length}\r\n\r\n${caidaoBody}`,
    );
    const encrypted = Buffer.from("9c23f045d88018b973e6a284c7510fa2b41d69e083d574ac91f6bc304e5d2a7f", "hex");
    const behinderHead = Buffer.from(
      `POST /admin/b.jsp HTTP/1.1\r\nHost: lab.local\r\nContent-Type: application/octet-stream\r\nContent-Length: ${encrypted.length}\r\n\r\n`,
    );
    const behinder = Buffer.concat([behinderHead, encrypted]);
    const encryptedReply = Buffer.from("c7f104a9e3226b0db7e859013cda42f8a94b6d12e0735fca5b189dc062f74e91", "hex");
    const behinderResponse = Buffer.concat([
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${encryptedReply.length}\r\n\r\n`),
      encryptedReply,
    ]);
    const report = analyzePcap(
      pcap(tcpFrame(client, server, 51003, 80, 1, caidao), tcpFrame(client, server, 51004, 80, 1, behinder), tcpFrame(server, client, 80, 51004, 1, behinderResponse)),
    ).report;
    expect(report.webshells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: "Caidao", confidence: "medium" }),
        expect.objectContaining({ family: "Behinder", confidence: "low" }),
      ]),
    );
  });

  test("recognizes Caidao with a changed password parameter and one z0 payload", () => {
    const body = "pass=eval%28base64_decode%28%24_POST%5Bz0%5D%29%29&z0=QHN5c3RlbSgnbHMnKTs=";
    const request = Buffer.from(
      `POST /gateway HTTP/1.1\r\nHost: lab.local\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    const report = analyzePcap(pcap(tcpFrame(client, server, 51011, 8080, 1, request))).report;
    expect(report.webshells).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "Caidao", httpId: "http-1" }),
    ]));
  });

  test("recognizes an AntSword-style custom parameter without a literal ant field", () => {
    const body = "pass=%40eval%28base64_decode%28%24_POST%5Bpass%5D%29%29%3Bfunction_exists%28%22system%22%29";
    const request = Buffer.from(
      `POST /api/dispatch HTTP/1.1\r\nHost: lab.local\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    const report = analyzePcap(pcap(tcpFrame(client, server, 51012, 8080, 1, request))).report;
    expect(report.webshells).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "AntSword", httpId: "http-1" }),
    ]));
  });

  test("does not label an ordinary binary upload as Behinder", () => {
    const body = Buffer.alloc(48, 0x90);
    const request = Buffer.concat([
      Buffer.from(`POST /upload.php HTTP/1.1\r\nHost: lab.local\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`),
      body,
    ]);
    const report = analyzePcap(pcap(tcpFrame(client, server, 51013, 80, 1, request))).report;
    expect(report.webshells.some((item) => item.family === "Behinder")).toBe(false);
  });

  test("recognizes base64-wrapped opaque request and response as a low-confidence Behinder candidate", () => {
    const encrypted = Buffer.from("9c23f045d88018b973e6a284c7510fa2b41d69e083d574ac91f6bc304e5d2a7f", "hex").toString("base64");
    const reply = Buffer.from("c7f104a9e3226b0db7e859013cda42f8a94b6d12e0735fca5b189dc062f74e91", "hex").toString("base64");
    const request = Buffer.from(`POST /shell.php HTTP/1.1\r\nHost: lab.local\r\nContent-Length: ${encrypted.length}\r\n\r\n${encrypted}`);
    const response = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${reply.length}\r\n\r\n${reply}`);
    const report = analyzePcap(pcap(tcpFrame(client, server, 51014, 80, 1, request), tcpFrame(server, client, 80, 51014, 1, response))).report;
    expect(report.webshells).toEqual(expect.arrayContaining([expect.objectContaining({ family: "Behinder", confidence: "low" })]));
  });

  test("adds TShark-reassembled HTTP evidence when the native parser missed a request", () => {
    const report = analyzePcap(pcap()).report;
    enrichPcapReport(report, [{
      frame: 12, source: "10.0.0.4", target: "10.0.0.9", sourcePort: 51000, targetPort: 8080,
      stream: 3, method: "POST", path: "/gateway", host: "lab.local", contentType: "application/x-www-form-urlencoded",
      body: Buffer.from("pass=@eval(base64_decode($POST[pass]));function_exists('system')"), responseFrame: 14,
    }, {
      frame: 14, source: "10.0.0.9", target: "10.0.0.4", sourcePort: 8080, targetPort: 51000,
      stream: 3, status: 200, body: Buffer.from("ok"), requestFrame: 12,
    }]);
    expect(report.http).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", path: "/gateway", status: 200 }),
    ]));
    expect(report.webshells).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "AntSword", httpId: "http-1" }),
    ]));
  });

  test("keeps repeated identical TShark HTTP requests distinct", () => {
    const report = analyzePcap(pcap()).report;
    enrichPcapReport(report, [1, 2].map((frame) => ({ frame, source: "10.0.0.4", target: "10.0.0.9",
      sourcePort: 51000, targetPort: 8080, stream: 3, method: "POST", path: "/gateway", host: "lab.local",
      body: Buffer.from(`z0=payload${frame}&z1=more${frame}`) })));
    expect(report.http.map((item) => item.requestRaw)).toEqual(["z0=payload1&z1=more1", "z0=payload2&z1=more2"]);
    expect(report.webshells).toHaveLength(2);
  });
});
