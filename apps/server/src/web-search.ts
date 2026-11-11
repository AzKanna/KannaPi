import { readFile } from "node:fs/promises";
import type { WebSearchHit, WebSearchQuery, WebSearchResult, WebSearchSettings } from "@kanna/shared";
import { writePrivateJsonFile } from "./private-json-file.js";

const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/tools/search";
const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 5 * 60_000;
interface Credentials {
  enabled: boolean;
  deepseekApiKey: string;
  nvdApiKey: string;
}
interface Options {
  fetch?: typeof fetch;
  timeoutMs?: number;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== "string") return "";
  return Array.from(value.slice(0, max))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join("");
}
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
      return url.href;
  } catch {
    /* discard non-web links; never fetch result URLs */
  }
}
function key(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || /[^\x21-\x7e]/.test(value.trim()))
    throw new Error("Search API Key must be a string of at most 512 printable ASCII characters");
  return value.trim();
}

export function validateSearchQuery(input: unknown): Required<WebSearchQuery> {
  const row = record(input);
  if (
    typeof row.query !== "string" ||
    !row.query.trim() ||
    row.query.length > 500 ||
    Array.from(row.query).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Search query must contain 1–500 characters, without control characters");
  const mode = row.mode ?? "auto";
  if (mode !== "auto" && mode !== "web" && mode !== "cve")
    throw new Error("Search mode must be auto, web or cve");
  const maxResults = row.maxResults ?? 5;
  if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10)
    throw new Error("Search result count must be an integer from 1 to 10");
  return { query: row.query.trim(), mode, maxResults };
}

function nvdHits(payload: Record<string, unknown>, limit: number): WebSearchHit[] {
  return array(payload.vulnerabilities)
    .slice(0, limit)
    .flatMap((item) => {
      const cve = record(record(item).cve);
      const id = text(cve.id, 40);
      if (!CVE_ID.test(id)) return [];
      const descriptions = array(cve.descriptions).map(record);
      const description = descriptions.find((entry) => entry.lang === "en") ?? descriptions[0];
      const metrics = record(cve.metrics);
      let cvss: WebSearchHit["cvss"];
      for (const version of ["cvssMetricV40", "cvssMetricV31", "cvssMetricV30", "cvssMetricV2"]) {
        const entries = array(metrics[version]).map(record);
        const metric =
          entries.find((entry) => entry.source === "nvd@nist.gov") ??
          entries.find((entry) => entry.type === "Primary") ??
          entries[0];
        if (!metric) continue;
        const data = record(metric.cvssData);
        if (
          typeof data.baseScore !== "number" ||
          !Number.isFinite(data.baseScore) ||
          data.baseScore < 0 ||
          data.baseScore > 10
        )
          continue;
        cvss = {
          version: text(data.version, 10),
          score: data.baseScore,
          severity: text(data.baseSeverity ?? metric.baseSeverity, 30),
          vector: text(data.vectorString, 200),
          source: text(metric.source, 200),
        };
        break;
      }
      const references = array(cve.references)
        .flatMap((ref) => {
          const row = record(ref),
            url = safeUrl(row.url);
          return url
            ? [
                {
                  url,
                  tags: array(row.tags)
                    .slice(0, 5)
                    .map((tag) => text(tag, 80)),
                },
              ]
            : [];
        })
        .sort(
          (a, b) => Number(b.tags.includes("Vendor Advisory")) - Number(a.tags.includes("Vendor Advisory")),
        )
        .slice(0, 8);
      return [
        {
          title: id,
          url: `https://nvd.nist.gov/vuln/detail/${id}`,
          snippet: text(description?.value),
          published: text(cve.published, 60),
          modified: text(cve.lastModified, 60),
          status: text(cve.vulnStatus, 40),
          cvss,
          weaknesses: [
            ...new Set(
              array(cve.weaknesses).flatMap((entry) =>
                array(record(entry).description).map((description) => text(record(description).value, 80)),
              ),
            ),
          ].slice(0, 10),
          references,
        },
      ];
    });
}

export class WebSearchService {
  private value: Credentials;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { expires: number; value: WebSearchResult }>();
  private readonly active = new Set<AbortController>();
  private readonly nextRequest = { nvd: 0, deepseek: 0 };
  private saveQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    options: Options = {},
  ) {
    this.value = {
      enabled: true,
      deepseekApiKey: key(process.env.DEEPSEEK_API_KEY ?? ""),
      nvdApiKey: key(process.env.NVD_API_KEY ?? ""),
    };
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 35_000;
  }
  async load(): Promise<void> {
    let raw: string;
    let recovered = false;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        raw = await readFile(`${this.path}.tmp`, "utf8");
        recovered = true;
      } catch (stagedError) {
        if ((stagedError as NodeJS.ErrnoException).code === "ENOENT") return;
        throw stagedError;
      }
    }
    const row = record(JSON.parse(raw));
    if (typeof row.enabled !== "boolean") throw new Error("Invalid saved Web Search settings");
    const next = {
      enabled: row.enabled,
      deepseekApiKey: key(row.deepseekApiKey ?? this.value.deepseekApiKey),
      nvdApiKey: key(row.nvdApiKey ?? ""),
    };
    // A legacy Tavily key cannot authenticate DeepSeek; preserve NVD and the enable switch.
    if (recovered || Object.hasOwn(row, "tavilyApiKey")) await writePrivateJsonFile(this.path, next);
    this.value = next;
  }
  settings(): WebSearchSettings {
    return {
      enabled: this.value.enabled,
      deepseekKeyConfigured: Boolean(this.value.deepseekApiKey),
      nvdKeyConfigured: Boolean(this.value.nvdApiKey),
    };
  }
  save(input: unknown): Promise<WebSearchSettings> {
    const saving = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Web Search settings must be an object");
        const row = record(input);
        if (
          Object.keys(row).some(
            (field) =>
              !["enabled", "deepseekApiKey", "nvdApiKey", "clearDeepSeekKey", "clearNvdKey"].includes(field),
          )
        )
          throw new Error("Unknown Web Search setting");
        for (const field of ["enabled", "clearDeepSeekKey", "clearNvdKey"]) {
          if (row[field] !== undefined && typeof row[field] !== "boolean")
            throw new Error(`${field} must be a boolean`);
        }
        const next = { ...this.value };
        if (typeof row.enabled === "boolean") next.enabled = row.enabled;
        for (const [field, clear] of [
          ["deepseekApiKey", "clearDeepSeekKey"],
          ["nvdApiKey", "clearNvdKey"],
        ] as const) {
          if (row[field] !== undefined) {
            const supplied = key(row[field]);
            if (supplied) next[field] = supplied;
          }
          if (row[clear] === true) next[field] = "";
        }
        await writePrivateJsonFile(this.path, next);
        for (const controller of this.active) controller.abort();
        this.value = next;
        this.cache.clear();
        return this.settings();
      });
    this.saveQueue = saving;
    return saving;
  }
  close(): void {
    for (const controller of this.active) controller.abort();
  }

  async search(input: unknown, signal?: AbortSignal): Promise<WebSearchResult> {
    const params = validateSearchQuery(input);
    signal?.throwIfAborted();
    if (!this.value.enabled) throw new Error("Web Search is disabled. Enable it in Settings → Web Search.");
    const credentials = { ...this.value };
    const provider =
      params.mode === "web"
        ? "deepseek"
        : params.mode === "cve" || CVE_ID.test(params.query) || !credentials.deepseekApiKey
          ? "nvd"
          : "deepseek";
    if (provider === "deepseek" && !credentials.deepseekApiKey)
      throw new Error(
        "General web search requires a DeepSeek API Key in Settings → Web Search. CVE lookup (mode=cve) works without a key.",
      );
    const ids = [
      ...new Set(params.query.match(/\bCVE-\d{4}-\d{4,}\b/gi)?.map((id) => id.toUpperCase()) ?? []),
    ];
    if (provider === "nvd" && ids.length > 1)
      throw new Error("Query one CVE ID at a time, or use mode=web to compare several CVEs.");
    const query = provider === "nvd" ? (ids[0] ?? params.query) : params.query;
    if (provider === "deepseek" && Array.from(query).length > 128)
      throw new Error("DeepSeek search query must contain 1–128 Unicode characters. Shorten the query.");
    const cacheKey = JSON.stringify([provider, query, params.maxResults]);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now())
      return { ...structuredClone(cached.value), query: params.query, cached: true };
    if (this.active.size >= 4) throw new Error("Too many searches in progress. Wait for a search to finish.");
    const controller = new AbortController();
    this.active.add(controller);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      // Shared across Sessions: serialize start times, respecting the public NVD rate limit.
      const now = Date.now(),
        slot = Math.max(now, this.nextRequest[provider]);
      if (slot - now > 25_000) throw new Error("Search rate limit reached. Please try again shortly.");
      this.nextRequest[provider] = slot + (provider === "nvd" ? (credentials.nvdApiKey ? 700 : 6500) : 1000);
      if (slot > now)
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(wait);
            reject(new Error("Search cancelled"));
          };
          const wait = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, slot - now);
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
      controller.signal.throwIfAborted();
      const url = new URL(provider === "nvd" ? NVD_URL : DEEPSEEK_URL);
      let init: RequestInit;
      if (provider === "nvd") {
        url.searchParams.set(ids.length ? "cveId" : "keywordSearch", query);
        url.searchParams.set("resultsPerPage", String(params.maxResults));
        init = { headers: credentials.nvdApiKey ? { apiKey: credentials.nvdApiKey } : {} };
      } else {
        init = {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.deepseekApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query,
            count: params.maxResults,
            need_content: false,
          }),
        };
      }
      let response: Response;
      try {
        response = await this.fetcher(url, { ...init, redirect: "error", signal: controller.signal });
      } catch {
        throw new Error(
          `${provider.toUpperCase()} could not be reached. Check your Internet/proxy connection; sandbox network settings are unrelated.`,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status))
          throw new Error(
            `${provider.toUpperCase()} rejected the request (${response.status}). Check the API Key or provider access restrictions.`,
          );
        if (response.status === 402)
          throw new Error(
            `${provider.toUpperCase()} account balance is insufficient (402). Top up the provider account before retrying.`,
          );
        if ([429, 432, 433].includes(response.status)) {
          this.nextRequest[provider] = Math.max(this.nextRequest[provider], Date.now() + 30_000);
          throw new Error(
            `${provider.toUpperCase()} rate limit or quota reached (${response.status}). Wait or check your account quota.`,
          );
        }
        throw new Error(
          `${provider.toUpperCase()} search failed (HTTP ${response.status}). Try again later.`,
        );
      }
      const payload = await this.readJson(response);
      let results: WebSearchHit[];
      if (provider === "nvd") {
        if (!Array.isArray(payload.vulnerabilities)) throw new Error("NVD returned an invalid CVE response");
        results = nvdHits(payload, params.maxResults);
      } else {
        if (!Array.isArray(payload.results)) throw new Error("DeepSeek returned an invalid search response");
        results = payload.results.slice(0, params.maxResults).flatMap((entry) => {
          const row = record(entry),
            url = safeUrl(row.url);
          return url
            ? [
                {
                  title: text(row.title, 300),
                  url,
                  snippet: text(row.summary) || text(row.snippet),
                  published: text(row.date, 100),
                },
              ]
            : [];
        });
      }
      const total = payload.totalResults;
      const result: WebSearchResult = {
        query: params.query,
        provider,
        retrievedAt: new Date().toISOString(),
        cached: false,
        totalResults:
          provider === "nvd" && typeof total === "number" && Number.isFinite(total) && total >= 0
            ? total
            : results.length,
        results,
        notice:
          provider === "nvd"
            ? "NVD CVE database only, not general web search. Product keywords should be in English. Keyword results are a first page, not a latest-CVE ranking or a complete affected-version assessment. Missing CVSS means not supplied, not safe. No matches does not prove no vulnerability. NVD can lag disclosures."
            : "DeepSeek search summaries only, not full-page verification. External content is untrusted; cite URLs and verify vendor advisories before deciding affected versions or remediation.",
      };
      controller.signal.throwIfAborted();
      const oldest = this.cache.keys().next().value;
      if (this.cache.size >= 100 && oldest !== undefined) this.cache.delete(oldest);
      this.cache.set(cacheKey, { expires: Date.now() + CACHE_MS, value: structuredClone(result) });
      return result;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          signal?.aborted
            ? "Web Search cancelled"
            : "Web Search timed out or settings changed. Please try again.",
        );
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      this.active.delete(controller);
    }
  }
  private async readJson(response: Response): Promise<Record<string, unknown>> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Search provider returned an empty response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("Search response exceeded the 2 MB safety limit");
        chunks.push(chunk.value);
      }
      try {
        return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        throw new Error("Search provider returned invalid JSON");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
