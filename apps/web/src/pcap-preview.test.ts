import { describe, expect, test } from "vitest";
import { buildPcapAgentEvidence, type PcapReport } from "../../server/src/pcap-analysis.js";
import { buildOriginalCaptureDisclosure, buildPcapPreview } from "./pcap-preview.js";

const report = {
  name: "capture.pcap", packetCount: 3, encryptedStreams: 0, decryption: { status: "not-needed" },
  assets: [], links: [], webshells: [], files: [], warnings: [],
  credentials: [{ id: "cred-1", kind: "HTTP Basic", username: "alice", value: "private-password", source: "a", target: "b", evidence: "POST /login" }],
  http: [{ id: "http-1", source: "a", target: "b", method: "POST", path: "/login", host: "b", port: 80, requestPreview: "password=[redacted]", requestRaw: "password=private-password", fileIds: [] }],
};

describe("PCAP Agent preview", () => {
  test("masks credential values and raw HTTP by default", () => {
    expect(buildPcapPreview(report, "overview", false)).not.toContain("private-password");
    expect(buildPcapPreview(report, "cred-1", false)).not.toContain("private-password");
    expect(buildPcapPreview(report, "http-1", false)).not.toContain("private-password");
  });

  test("shows only selected raw evidence after explicit reveal", () => {
    expect(buildPcapPreview(report, "cred-1", true)).toContain("private-password");
    expect(buildPcapPreview(report, "http-1", true)).toContain("password=private-password");
  });

  test("shows exactly the bounded payload that the server will send", () => {
    const large = { ...report, http: report.http.map((entry) => ({ ...entry, requestRaw: "a".repeat(8_192), responseRaw: "b".repeat(8_192) })) };
    for (const selection of ["overview", "cred-1", "http-1"])
      for (const includeRaw of [false, true])
        expect(buildPcapPreview(large, selection, includeRaw)).toBe(
          buildPcapAgentEvidence(large as unknown as PcapReport, selection, includeRaw),
        );
  });

  test("discloses original capture identity and that raw bytes are not previewed", () => {
    expect(buildOriginalCaptureDisclosure({ name: "capture.pcap", byteCount: 24, captureSha256: "ab".repeat(32) })).toContain("capture.pcap");
    expect(buildOriginalCaptureDisclosure({ name: "capture.pcap", byteCount: 24, captureSha256: "ab".repeat(32) })).toContain("ab".repeat(32));
    expect(buildOriginalCaptureDisclosure({ name: "capture.pcap", byteCount: 24 })).toMatch(/not displayed|not previewed/i);
  });
});
