import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_ROWS = 5_000;

export interface TsharkHttpRow {
  frame: number;
  source: string;
  target: string;
  sourcePort: number;
  targetPort: number;
  stream: number;
  method?: string;
  path?: string;
  host?: string;
  status?: number;
  contentType?: string;
  body: Buffer;
  requestFrame?: number;
  responseFrame?: number;
}

function optionalNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function fieldBody(value: string): Buffer {
  const hex = value.replace(/:/g, "");
  if (!hex || hex.length > 2 * 1024 * 1024 || hex.length % 2 || !/^[a-f0-9]+$/i.test(hex))
    return Buffer.alloc(0);
  return Buffer.from(hex, "hex");
}

export function parseTsharkHttpRows(output: string): TsharkHttpRow[] {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT) throw new Error("TShark output exceeds the analysis limit");
  const rows: TsharkHttpRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (rows.length >= MAX_ROWS) throw new Error("TShark HTTP record limit reached");
    const fields = line.split("\t");
    if (fields.length !== 14) throw new Error("TShark returned malformed HTTP fields");
    const frame = optionalNumber(fields[0]!);
    const sourcePort = optionalNumber(fields[3]!);
    const targetPort = optionalNumber(fields[4]!);
    const stream = optionalNumber(fields[5]!);
    if (!frame || !fields[1] || !fields[2] || sourcePort === undefined || targetPort === undefined || stream === undefined)
      continue;
    rows.push({
      frame,
      source: fields[1]!.slice(0, 100),
      target: fields[2]!.slice(0, 100),
      sourcePort,
      targetPort,
      stream,
      method: fields[6]?.slice(0, 16) || undefined,
      path: fields[7]?.slice(0, 300) || undefined,
      host: fields[8]?.slice(0, 180) || undefined,
      status: optionalNumber(fields[9]!),
      contentType: fields[10]?.slice(0, 120) || undefined,
      body: fieldBody(fields[11]!),
      requestFrame: optionalNumber(fields[12]!),
      responseFrame: optionalNumber(fields[13]!),
    });
  }
  return rows;
}

export function bundledTsharkPath(repoRoot: string, resourcesPath?: string): string | undefined {
  const candidates = [
    resourcesPath && join(resourcesPath, "tshark", "tshark.exe"),
    join(repoRoot, "apps", "desktop", "build", "tshark", "tshark.exe"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

export async function dissectWithTshark(
  executable: string,
  capturePath: string,
  keyLogPath?: string,
): Promise<TsharkHttpRow[]> {
  const args = [
    "-n", "-2", "-r", capturePath,
    ...(keyLogPath ? ["-o", `tls.keylog_file:${keyLogPath}`] : []),
    "-Y", "http.request || http.response", "-T", "fields", "-E", "separator=/t", "-E", "occurrence=f",
    "-e", "frame.number", "-e", "ip.src", "-e", "ip.dst", "-e", "tcp.srcport", "-e", "tcp.dstport",
    "-e", "tcp.stream", "-e", "http.request.method", "-e", "http.request.uri", "-e", "http.host",
    "-e", "http.response.code", "-e", "http.content_type", "-e", "@http.file_data", "-e", "http.request_in", "-e", "http.response_in",
  ];
  try {
    const { stdout } = await execFileAsync(executable, args, {
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, WIRESHARK_DISABLE_UPDATE_CHECK: "1" },
    });
    return parseTsharkHttpRows(stdout);
  } catch {
    throw new Error("Bundled TShark could not dissect this capture within the time or output limits");
  }
}
