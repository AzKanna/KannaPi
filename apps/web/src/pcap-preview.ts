interface PreviewReport {
  name: string;
  packetCount: number;
  encryptedStreams: number;
  decryption: { status: string };
  assets: unknown[];
  links: unknown[];
  webshells: unknown[];
  files: unknown[];
  warnings: string[];
  credentials: Array<{ id: string; value: string }>;
  http: Array<{ id: string; requestRaw?: string; responseRaw?: string; requestPreview?: string; responsePreview?: string }>;
}

export function buildOriginalCaptureDisclosure(report: { name: string; byteCount: number; captureSha256?: string }): string {
  return [
    "Original capture attachment (binary)",
    `Name: ${report.name}`,
    `Size: ${report.byteCount} bytes`,
    `SHA-256: ${report.captureSha256 ?? "Unavailable for this older import"}`,
    "Raw packet bytes are not displayed in this preview. The complete original file will be copied to the Agent's local attachment workspace; it is not sent as a native model-API file.",
  ].join("\n");
}

export function buildPcapPreview(report: PreviewReport, selection: string, includeRaw: boolean): string {
  const metadata = { capture: report.name, packets: report.packetCount, encryptedStreams: report.encryptedStreams, decryption: report.decryption.status };
  if (selection === "overview") return JSON.stringify({
    ...metadata, assets: report.assets.slice(0, 40), links: report.links.slice(0, 80),
    webshells: report.webshells.slice(0, 30), files: report.files.slice(0, 30),
    credentials: report.credentials.slice(0, 20).map(({ value: _value, ...safe }) => safe),
    warnings: report.warnings,
  }).slice(0, 10_000);
  const http = report.http.find((item) => item.id === selection);
  if (http) {
    const { requestRaw, responseRaw, requestPreview: _requestPreview, responsePreview: _responsePreview, ...safe } = http;
    return JSON.stringify({ ...metadata, selected: includeRaw ? { ...safe, requestRaw, responseRaw } : safe }).slice(0, 10_000);
  }
  const credential = report.credentials.find((item) => item.id === selection);
  if (credential) {
    const { value, ...safe } = credential;
    return JSON.stringify({ ...metadata, selected: includeRaw ? { ...safe, value } : safe }).slice(0, 10_000);
  }
  const selected = [...report.webshells, ...report.assets, ...report.files, ...report.links].find((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as { id?: string; address?: string; source?: string; target?: string };
    return row.id === selection || row.address === selection || `${row.source}->${row.target}` === selection;
  });
  return JSON.stringify({ ...metadata, selected: selected ?? { message: "Selection not found" } }).slice(0, 10_000);
}
