import { mkdirSync } from "node:fs";
import { fileURLToPath as qaFileURLToPath } from "node:url";

const qaDir = new URL("../../../.tmp/pcap-qa/", import.meta.url);
mkdirSync(qaDir, { recursive: true });

import { createCipheriv, createHmac } from 'node:crypto';
import { chromium } from 'playwright';

function record(type, payload) {
  const header = Buffer.from([type, 3, 3, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}
function frame(source, target, sourcePort, targetPort, sequence, payload) {
  const bytes = Buffer.alloc(54 + payload.length);
  bytes.writeUInt16BE(0x0800, 12);
  bytes[14] = 0x45; bytes.writeUInt16BE(40 + payload.length, 16); bytes[22] = 64; bytes[23] = 6;
  Buffer.from(source).copy(bytes, 26); Buffer.from(target).copy(bytes, 30);
  bytes.writeUInt16BE(sourcePort, 34); bytes.writeUInt16BE(targetPort, 36); bytes.writeUInt32BE(sequence, 38);
  bytes[46] = 0x50; bytes[47] = 0x18; payload.copy(bytes, 54);
  return bytes;
}
function fixture() {
  const random = Buffer.alloc(32, 0x72);
  const clientSecret = Buffer.alloc(32, 0x21);
  const serverSecret = Buffer.alloc(32, 0x34);
  const expand = (secret, label, size) => {
    const name = Buffer.from(`tls13 ${label}`);
    const info = Buffer.concat([Buffer.from([0, size, name.length]), name, Buffer.from([0])]);
    return createHmac('sha256', secret).update(info).update(Buffer.from([1])).digest().subarray(0, size);
  };
  const encrypt = (text, secret) => {
    const plain = Buffer.concat([Buffer.from(text), Buffer.from([23])]);
    const header = Buffer.from([23, 3, 3, (plain.length + 16) >> 8, (plain.length + 16) & 255]);
    const cipher = createCipheriv('aes-128-gcm', expand(secret, 'key', 16), expand(secret, 'iv', 12));
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  const chBody = Buffer.alloc(34); chBody.writeUInt16BE(0x0303); random.copy(chBody, 2);
  const shBody = Buffer.alloc(38); shBody.writeUInt16BE(0x0303); Buffer.alloc(32, 0x16).copy(shBody, 2); shBody.writeUInt16BE(0x1301, 35);
  const handshake = (type, body) => record(22, Buffer.concat([Buffer.from([type, 0, 0, body.length]), body]));
  const ch = handshake(1, chBody); const sh = handshake(2, shBody);
  const basic = Buffer.from('alice:tls-password').toString('base64');
  const req = encrypt(`GET /secure HTTP/1.1\r\nHost: lab.local\r\nAuthorization: Basic ${basic}\r\n\r\n`, clientSecret);
  const res = encrypt('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 5\r\n\r\nhello', serverSecret);
  const client = [10, 0, 0, 4]; const server = [10, 0, 0, 9];
  const frames = [frame(client, server, 52000, 443, 1, ch), frame(server, client, 443, 52000, 1, sh), frame(client, server, 52000, 443, 1 + ch.length, req), frame(server, client, 443, 52000, 1 + sh.length, res)];
  const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6); header.writeUInt32LE(1, 20);
  const packets = frames.map((bytes, index) => {
    const meta = Buffer.alloc(16); meta.writeUInt32LE(1_700_000_000 + index); meta.writeUInt32LE(bytes.length, 8); meta.writeUInt32LE(bytes.length, 12);
    return Buffer.concat([meta, bytes]);
  });
  const keyLog = Buffer.from(`CLIENT_TRAFFIC_SECRET_0 ${random.toString('hex')} ${clientSecret.toString('hex')}\nSERVER_TRAFFIC_SECRET_0 ${random.toString('hex')} ${serverSecret.toString('hex')}\n`);
  return { capture: Buffer.concat([header, ...packets]), keyLog };
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4173/?workspace=pcap', { waitUntil: 'networkidle' });
  const { capture, keyLog } = fixture();
  await page.locator('input[accept=".pcap,.pcapng,.cap"]').setInputFiles({ name: 'tls-demo.pcap', mimeType: 'application/octet-stream', buffer: capture });
  await page.getByText('0 / 2 TLS directions decrypted').waitFor();
  await page.locator('input[accept^=".log"]').setInputFiles({ name: 'tls-demo.keys', mimeType: 'text/plain', buffer: keyLog });
  await page.getByText('2 / 2 TLS directions decrypted').waitFor();
  await page.getByRole('button', { name: /^HTTP\s*1$/ }).click();
  await page.getByRole('button', { name: /GET lab.local\/secure/ }).waitFor();
  await page.getByRole('button', { name: /^Credentials\s*1$/ }).click();
  await page.getByRole('button', { name: /HTTP Basic/ }).click();
  const preview = await page.locator('.pcap-preview').innerText();
  if (preview.includes('tls-password')) throw new Error('Credential leaked into default Agent preview');
  await page.screenshot({ path: qaFileURLToPath(new URL("pcap-ui-tls.png", qaDir)), fullPage: true });
  if (errors.length) throw new Error(`Page errors: ${errors.join(', ')}`);
  console.log(JSON.stringify({ decrypted: '2 / 2', http: 1, credentials: 1, defaultPreviewMasked: true, errors }, null, 2));
} finally {
  await browser.close();
}
