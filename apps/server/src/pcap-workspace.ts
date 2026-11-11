import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { analyzePcap, enrichPcapReport, type PcapReport } from "./pcap-analysis.js";
import { dissectWithTshark } from "./pcap-tshark.js";
import { writePrivateJsonFile } from "./private-json-file.js";

export interface PcapReportSummary {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  format: PcapReport["format"];
  packetCount: number;
  byteCount: number;
  assets: number;
  httpCount: number;
  webshellCount: number;
  fileCount: number;
}

function summarize(report: PcapReport): PcapReportSummary {
  return {
    id: report.id,
    projectId: report.projectId,
    name: report.name,
    createdAt: report.createdAt,
    format: report.format,
    packetCount: report.packetCount,
    byteCount: report.byteCount,
    assets: report.assets.length,
    httpCount: report.http.length,
    webshellCount: report.webshells.length,
    fileCount: report.files.length,
  };
}

function validIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error("Invalid PCAP identifier");
  return value;
}

export class PcapWorkspaceService {
  private readonly root: string;
  constructor(
    root: string,
    private readonly tshark?: { executable: string; dissect?: typeof dissectWithTshark },
  ) {
    this.root = resolve(root);
  }

  private async enrichWithTshark(report: PcapReport, capturePath: string, keyLog?: Buffer): Promise<void> {
    if (!this.tshark) {
      report.tshark = { status: "unavailable", httpRecords: 0 };
      return;
    }
    let temporaryDirectory: string | undefined;
    let keyLogPath: string | undefined;
    try {
      if (keyLog) {
        temporaryDirectory = await mkdtemp(resolve(tmpdir(), "kanna-pcap-keylog-") + "-");
        keyLogPath = resolve(temporaryDirectory, "tls.keys");
        await writeFile(keyLogPath, keyLog, { flag: "wx", mode: 0o600 });
      }
      const rows = await (this.tshark.dissect ?? dissectWithTshark)(this.tshark.executable, capturePath, keyLogPath);
      enrichPcapReport(report, rows);
      report.tshark = { status: "used", httpRecords: rows.length };
    } catch {
      report.tshark = { status: "failed", httpRecords: 0 };
      report.warnings.push("Bundled TShark analysis failed or exceeded its limits; native PCAP results remain available");
    } finally {
      if (keyLogPath) await unlink(keyLogPath).catch(() => undefined);
      if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => undefined);
    }
  }

  private path(projectId: string, reportId?: string, file?: string): string {
    const parts = [this.root, validIdentifier(projectId)];
    if (reportId !== undefined) parts.push(validIdentifier(reportId));
    if (file !== undefined)
      parts.push(
        ["report.json", "summary.json", "capture.pcap"].includes(file) ? file : validIdentifier(file),
      );
    const target = resolve(...parts);
    if (!target.startsWith(`${this.root}${sep}`)) throw new Error("Invalid PCAP identifier");
    return target;
  }

  async importCapture(projectId: string, filename: string, bytes: Buffer): Promise<PcapReport> {
    const project = validIdentifier(projectId);
    if (!/\.(?:pcap|pcapng|cap)$/i.test(filename) || filename.length > 240)
      throw new Error("Select a .pcap or .pcapng capture");
    const result = analyzePcap(bytes, filename);
    result.report.captureSha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `pcap-${randomUUID()}`;
    result.report.id = id;
    result.report.projectId = project;
    const directory = this.path(project, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path(project, id, "capture.pcap"), bytes, { flag: "wx", mode: 0o600 });
      await this.enrichWithTshark(result.report, this.path(project, id, "capture.pcap"));
      for (const file of result.files)
        await writeFile(this.path(project, id, file.id), file.bytes, { flag: "wx", mode: 0o600 });
      await writeFile(this.path(project, id, "report.json"), JSON.stringify(result.report), {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(this.path(project, id, "summary.json"), JSON.stringify(summarize(result.report)), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return result.report;
  }

  async list(projectId: string): Promise<PcapReportSummary[]> {
    const directory = this.path(projectId);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const reports = await Promise.all(
      entries
        .filter((entry) => /^pcap-[a-f0-9-]{36}$/.test(entry))
        .slice(0, 100)
        .map(async (entry) => {
          try {
            const summary = JSON.parse(
              await readFile(this.path(projectId, entry, "summary.json"), "utf8"),
            ) as PcapReportSummary;
            if (summary.id !== entry || summary.projectId !== projectId) return undefined;
            return summary;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              try {
                return summarize(await this.get(projectId, entry));
              } catch {
                return undefined;
              }
            }
            return undefined;
          }
        }),
    );
    return reports
      .filter((report): report is PcapReportSummary => Boolean(report))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(projectId: string, reportId: string): Promise<PcapReport> {
    try {
      const report = JSON.parse(
        await readFile(this.path(projectId, reportId, "report.json"), "utf8"),
      ) as PcapReport;
      if (report.id !== reportId || report.projectId !== projectId) throw new Error("PCAP report mismatch");
      return report;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("PCAP report not found");
      throw error;
    }
  }

  async applyTlsKeyLog(projectId: string, reportId: string, keyLog: Buffer): Promise<PcapReport> {
    const previous = await this.get(projectId, reportId);
    const capture = await readFile(this.path(projectId, reportId, "capture.pcap"));
    const result = analyzePcap(capture, previous.name, keyLog);
    await this.enrichWithTshark(result.report, this.path(projectId, reportId, "capture.pcap"), keyLog);
    result.report.id = previous.id;
    result.report.projectId = previous.projectId;
    result.report.createdAt = previous.createdAt;
    result.report.captureSha256 = previous.captureSha256 ?? createHash("sha256").update(capture).digest("hex");
    const ids = new Map<string, string>();
    for (const file of result.files) {
      const id = `tls-${createHash("sha256").update(file.id).update(file.bytes).digest("hex").slice(0, 40)}`;
      ids.set(file.id, id);
      try {
        await writeFile(this.path(projectId, reportId, id), file.bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    for (const file of result.report.files) file.id = ids.get(file.id) ?? file.id;
    for (const item of result.report.http) item.fileIds = item.fileIds.map((id) => ids.get(id) ?? id);
    await writePrivateJsonFile(this.path(projectId, reportId, "report.json"), result.report);
    await writePrivateJsonFile(this.path(projectId, reportId, "summary.json"), summarize(result.report));
    return result.report;
  }

  async readCapture(projectId: string, reportId: string): Promise<{ name: string; bytes: Buffer }> {
    const report = await this.get(projectId, reportId);
    return { name: report.name, bytes: await readFile(this.path(projectId, reportId, "capture.pcap")) };
  }

  async readFile(
    projectId: string,
    reportId: string,
    fileId: string,
  ): Promise<{ name: string; mediaType: string; bytes: Buffer }> {
    const report = await this.get(projectId, reportId);
    const file = report.files.find((item) => item.id === fileId);
    if (!file) throw new Error("Extracted file not found");
    return {
      name: file.name,
      mediaType: file.mediaType,
      bytes: await readFile(this.path(projectId, reportId, file.id)),
    };
  }
}
