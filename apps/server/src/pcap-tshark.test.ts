import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dissectWithTshark, parseTsharkHttpRows } from "./pcap-tshark.js";

function fixtureCapture(): Buffer {
  const body = "pass=eval%28base64_decode%28abc%29%29";
  const payload = Buffer.from(`POST /shell.php HTTP/1.1\r\nHost: lab.local\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  const frame = Buffer.alloc(54 + payload.length);
  frame.writeUInt16BE(0x0800, 12);
  frame[14] = 0x45;
  frame.writeUInt16BE(40 + payload.length, 16);
  frame[22] = 64;
  frame[23] = 6;
  Buffer.from([10, 0, 0, 4]).copy(frame, 26);
  Buffer.from([10, 0, 0, 9]).copy(frame, 30);
  frame.writeUInt16BE(51000, 34);
  frame.writeUInt16BE(80, 36);
  frame.writeUInt32BE(1, 38);
  frame[46] = 0x50;
  frame[47] = 0x18;
  payload.copy(frame, 54);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(1, 20);
  const packet = Buffer.alloc(16);
  packet.writeUInt32LE(1_700_000_000);
  packet.writeUInt32LE(frame.length, 8);
  packet.writeUInt32LE(frame.length, 12);
  return Buffer.concat([header, packet, frame]);
}

describe("TShark HTTP evidence import", () => {
  test("decodes hex-encoded request bodies and pairs response frames", () => {
    const request = ["12", "10.0.0.4", "10.0.0.9", "51000", "8080", "3", "POST", "/shell.php", "lab.local", "", "application/x-www-form-urlencoded", "706173733d6576616c", "", "14"].join("\t");
    const response = ["14", "10.0.0.9", "10.0.0.4", "8080", "51000", "3", "", "", "", "200", "application/octet-stream", "01020304", "12", ""].join("\t");
    const rows = parseTsharkHttpRows(`${request}\n${response}\n`);
    expect(rows).toEqual([
      expect.objectContaining({ frame: 12, method: "POST", path: "/shell.php", body: Buffer.from("pass=eval"), responseFrame: 14 }),
      expect.objectContaining({ frame: 14, status: 200, requestFrame: 12, body: Buffer.from("01020304", "hex") }),
    ]);
  });

  test("rejects oversized or malformed dissector output", () => {
    expect(() => parseTsharkHttpRows("bad\tline")).toThrow(/TShark/i);
    expect(() => parseTsharkHttpRows("x".repeat(17 * 1024 * 1024))).toThrow(/TShark/i);
  });

  test.skipIf(!process.env.KANNAPI_TEST_TSHARK_PATH)("reads a real HTTP form body using the bundled TShark CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kanna-tshark-fixture-"));
    try {
      const capture = join(directory, "fixture.pcap");
      await writeFile(capture, fixtureCapture());
      const rows = await dissectWithTshark(process.env.KANNAPI_TEST_TSHARK_PATH!, capture);
      expect(rows[0]).toMatchObject({ method: "POST", path: "/shell.php", body: expect.any(Buffer) });
      expect(rows[0]?.body.toString("utf8")).toContain("pass=eval");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
