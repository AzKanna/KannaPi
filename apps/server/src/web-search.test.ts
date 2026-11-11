import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { validateSearchQuery, WebSearchService } from "./web-search.js";

const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("NVD_API_KEY", "");
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(fetcher: typeof fetch, timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "kanna-search-"));
  directories.push(directory);
  const path = join(directory, "web-search-auth.json");
  return { service: new WebSearchService(path, { fetch: fetcher, timeoutMs }), path };
}
const nvdPayload = {
  totalResults: 1,
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2024-3094",
        descriptions: [
          { lang: "es", value: "Spanish" },
          { lang: "en", value: "xz supply chain issue" },
        ],
        published: "2024-03-29T17:15:21.150",
        lastModified: "2026-06-17T07:43:17.830",
        vulnStatus: "Modified",
        metrics: {
          cvssMetricV31: [
            {
              source: "nvd@nist.gov",
              cvssData: {
                version: "3.1",
                baseScore: 10,
                baseSeverity: "CRITICAL",
                vectorString: "CVSS:3.1/AV:N",
              },
            },
          ],
        },
        weaknesses: [{ description: [{ value: "CWE-506" }] }],
        references: [
          { url: "javascript:alert(1)" },
          { url: "https://example.org/advisory", tags: ["Vendor Advisory"] },
        ],
      },
    },
  ],
};

test("validates query, result count and mode before any request", () => {
  expect(validateSearchQuery({ query: " Apache ", maxResults: 10 })).toEqual({
    query: "Apache",
    mode: "auto",
    maxResults: 10,
  });
  for (const row of [
    { query: "" },
    { query: "a\nsecret" },
    { query: "a".repeat(501) },
    { query: "a", mode: "fetch" },
    { query: "a", maxResults: 11 },
    { query: "a", maxResults: 1.5 },
    { query: "a", maxResults: "5" },
  ])
    expect(() => validateSearchQuery(row)).toThrow();
});

test("persists keys privately, preserves blank input, clears explicitly and rejects malformed settings", async () => {
  const { service, path } = await fixture(vi.fn());
  const saved = await service.save({
    enabled: true,
    deepseekApiKey: "test-deepseek-secret",
    nvdApiKey: "test-nvd-secret",
  });
  expect(saved).toEqual({ enabled: true, deepseekKeyConfigured: true, nvdKeyConfigured: true });
  expect(JSON.stringify(saved)).not.toContain("test-deepseek-secret");
  const resumed = new WebSearchService(path);
  await resumed.load();
  expect(resumed.settings()).toEqual(saved);
  await resumed.save({ deepseekApiKey: "", enabled: false });
  expect(resumed.settings().deepseekKeyConfigured).toBe(true);
  await resumed.save({ clearDeepSeekKey: true, clearNvdKey: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    enabled: false,
    deepseekApiKey: "",
    nvdApiKey: "",
  });
  for (const row of [
    { enabled: "yes" },
    { nvdApiKey: 123 },
    { deepseekApiKey: "secret\nheader" },
    { clearNvdKey: "yes" },
    { baseUrl: "http://127.0.0.1" },
  ])
    await expect(service.save(row)).rejects.toThrow();
});

test("recovers the staged first-save credentials without exposing or requesting the key again", async () => {
  const { service, path } = await fixture(vi.fn());
  await writeFile(
    `${path}.tmp`,
    JSON.stringify({ enabled: true, deepseekApiKey: "test-recovered-secret", nvdApiKey: "" }),
    { mode: 0o600 },
  );
  await service.load();
  expect(service.settings()).toEqual({ enabled: true, deepseekKeyConfigured: true, nvdKeyConfigured: false });
  expect(JSON.stringify(service.settings())).not.toContain("test-recovered-secret");
  expect(JSON.parse(await readFile(path, "utf8")).deepseekApiKey).toBe("test-recovered-secret");
  await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  const resumed = new WebSearchService(path);
  await resumed.load();
  expect(resumed.settings()).toEqual(service.settings());
});

test("does not replace existing committed credentials with a failed update's temporary file", async () => {
  const { service, path } = await fixture(vi.fn());
  await service.save({ enabled: true, deepseekApiKey: "committed-secret" });
  await writeFile(
    `${path}.tmp`,
    JSON.stringify({ enabled: true, deepseekApiKey: "failed-secret", nvdApiKey: "" }),
  );
  const resumed = new WebSearchService(path);
  await resumed.load();
  expect(JSON.parse(await readFile(path, "utf8")).deepseekApiKey).toBe("committed-secret");
  await expect(stat(`${path}.tmp`)).resolves.toBeDefined();
});

test("uses fixed NVD endpoint with bounded metadata, safe references, key headers and cache", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(nvdPayload));
  const { service } = await fixture(fetcher);
  await service.save({ nvdApiKey: "nvd-secret" });
  const result = await service.search({ query: "cve-2024-3094" });
  expect(result.provider).toBe("nvd");
  expect(result.cached).toBe(false);
  const hit = result.results[0]!;
  expect(hit.snippet).toBe("xz supply chain issue");
  expect(hit.cvss?.score).toBe(10);
  expect(hit.weaknesses).toEqual(["CWE-506"]);
  expect(hit.references).toEqual([{ url: "https://example.org/advisory", tags: ["Vendor Advisory"] }]);
  expect(hit.url).toBe("https://nvd.nist.gov/vuln/detail/CVE-2024-3094");
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain("https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2024-3094");
  expect(init?.headers).toEqual({ apiKey: "nvd-secret" });
  expect(init?.redirect).toBe("error");
  expect(JSON.stringify(result)).not.toContain("nvd-secret");
  expect((await service.search({ query: "CVE-2024-3094" })).cached).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await service.save({ enabled: false });
  await expect(service.search({ query: "CVE-2024-3094" })).rejects.toThrow("disabled");
});

test("auto keywords without DeepSeek search NVD only, not a fabricated web fallback", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ vulnerabilities: [], totalResults: 0 }));
  const { service } = await fixture(fetcher);
  const result = await service.search({ query: "Apache Log4j" });
  expect(new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("keywordSearch")).toBe("Apache Log4j");
  expect(result.notice).toContain("not general web search");
  expect(result.results).toEqual([]);
  await expect(service.search({ query: "CVE-2024-3094 CVE-2021-44228", mode: "cve" })).rejects.toThrow(
    "one CVE",
  );
  await expect(service.search({ query: "Apache", mode: "web" })).rejects.toThrow("DeepSeek API Key");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("general web search uses DeepSeek summaries only; exact CVE auto still uses NVD", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).includes("deepseek")
      ? Response.json({
          results: [
            {
              title: "Advisory",
              url: "https://example.org/a",
              summary: "a".repeat(4000),
              snippet: "short summary",
              content: "secret-extra",
              date: "2026-09-30T00:00:00Z",
            },
            { title: "Unsafe", url: "javascript:alert(1)", content: "bad" },
          ],
        })
      : Response.json(nvdPayload),
  );
  const { service } = await fixture(fetcher);
  await service.save({ deepseekApiKey: "deepseek-secret" });
  const result = await service.search({ query: "Apache latest security advisory", maxResults: 2 });
  expect(result.provider).toBe("deepseek");
  expect(result.results).toHaveLength(1);
  expect(result.results[0]!.snippet).toHaveLength(2000);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe("https://api.deepseek.com/v1/tools/search");
  expect(init?.headers).toMatchObject({ authorization: "Bearer deepseek-secret" });
  expect(JSON.parse(String(init?.body))).toEqual({
    query: "Apache latest security advisory",
    count: 2,
    need_content: false,
  });
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("error");
  expect(result.results[0]?.published).toBe("2026-09-30T00:00:00Z");
  expect(JSON.stringify(result)).not.toContain("secret-extra");
  expect(JSON.stringify(result)).not.toContain("deepseek-secret");
  expect((await service.search({ query: "CVE-2024-3094" })).provider).toBe("nvd");
});

test("cancels a rate-limited queued search before starting another HTTP request", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(nvdPayload));
  const { service } = await fixture(fetcher);
  await service.search({ query: "CVE-2024-3094" });
  const controller = new AbortController();
  const search = service.search({ query: "CVE-2021-44228" }, controller.signal);
  controller.abort();
  await expect(search).rejects.toThrow("cancelled");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test("cancels in-flight searches on Stop, timeout and disabling settings", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("private detail should not leak")), {
          once: true,
        }),
      ),
  );
  const { service } = await fixture(fetcher, 40);
  await expect(service.search({ query: "CVE-2024-3094" })).rejects.toThrow("timed out");
  const { service: second } = await fixture(fetcher, 1000);
  const controller = new AbortController();
  const cancelled = second.search({ query: "CVE-2024-3094" }, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  const { service: third } = await fixture(fetcher, 1000);
  const disabled = third.search({ query: "CVE-2024-3094" });
  const failure = expect(disabled).rejects.toThrow("settings changed");
  await third.save({ enabled: false });
  await failure;
});

test("bounds provider response and reports HTTP/JSON errors without echoing provider secrets", async () => {
  for (const response of [
    new Response("deepseek-secret echo", { status: 401 }),
    new Response("quota", { status: 429 }),
    new Response("broken"),
    Response.json({ unexpected: true }),
    new Response(`"${"x".repeat(2 * 1024 * 1024)}"`),
  ]) {
    const { service } = await fixture(vi.fn<typeof fetch>().mockResolvedValue(response));
    const error = await service.search({ query: "CVE-2024-3094" }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("deepseek-secret");
  }
});

test("migrates legacy Tavily settings without treating its key as a DeepSeek credential", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const { service, path } = await fixture(fetcher);
  await writeFile(
    path,
    JSON.stringify({
      enabled: false,
      tavilyApiKey: "legacy-key-must-not-be-reused",
      nvdApiKey: "preserved-nvd-key",
    }),
  );
  await service.load();
  expect(service.settings()).toEqual({
    enabled: false,
    deepseekKeyConfigured: false,
    nvdKeyConfigured: true,
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    enabled: false,
    deepseekApiKey: "",
    nvdApiKey: "preserved-nvd-key",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test("loads DeepSeek environment key for legacy settings and respects explicit removal on restart", async () => {
  vi.stubEnv("DEEPSEEK_API_KEY", "environment-deepseek-key");
  const { service, path } = await fixture(vi.fn());
  await writeFile(path, JSON.stringify({ enabled: true, tavilyApiKey: "legacy-key", nvdApiKey: "" }));
  await service.load();
  expect(service.settings().deepseekKeyConfigured).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8")).deepseekApiKey).toBe("environment-deepseek-key");
  await service.save({ clearDeepSeekKey: true });
  const resumed = new WebSearchService(path);
  await resumed.load();
  expect(resumed.settings().deepseekKeyConfigured).toBe(false);
});

test("enforces DeepSeek's 128 Unicode-character limit before HTTP while preserving NVD query limits", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      String(url).includes("deepseek")
        ? Response.json({ results: [] })
        : Response.json({ vulnerabilities: [], totalResults: 0 }),
    );
  const { service } = await fixture(fetcher);
  await service.save({ deepseekApiKey: "deepseek-secret" });
  const query = "🧪".repeat(128);
  const result = await service.search({ query, mode: "web" });
  expect(result.provider).toBe("deepseek");
  expect(result.results).toEqual([]);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).query).toBe(query);
  await expect(service.search({ query: query + "🧪", mode: "web" })).rejects.toThrow("128 Unicode");
  await expect(service.search({ query: "a".repeat(129), mode: "auto" })).rejects.toThrow("128 Unicode");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await service.search({ query: "a".repeat(200), mode: "cve" })).provider).toBe("nvd");
});

test("falls back to DeepSeek's short snippet without reading full content or returning unsafe URLs", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      results: [
        {
          title: "Public source",
          url: "https://example.org/advisory",
          summary: "",
          snippet: "Short evidence",
          date: null,
          content: "ignored full page",
        },
        { title: "Credentials", url: "https://user:password@example.org/", summary: "must be discarded" },
        { title: "Unsafe", url: "javascript:alert(1)", summary: "must be discarded" },
      ],
    }),
  );
  const { service } = await fixture(fetcher);
  await service.save({ deepseekApiKey: "deepseek-secret" });
  const result = await service.search({ query: "advisory site:example.org", mode: "web" });
  expect(result.results).toEqual([
    {
      title: "Public source",
      url: "https://example.org/advisory",
      snippet: "Short evidence",
      published: "",
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("ignored full page");
  expect((await service.search({ query: "advisory site:example.org", mode: "web" })).cached).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  [401, "API Key"],
  [402, "balance is insufficient"],
  [429, "rate limit or quota"],
  [504, "HTTP 504"],
])(
  "reports DeepSeek HTTP %i without exposing provider error bodies or retrying",
  async (status, expected) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("deepseek-secret echoed by provider", { status }));
    const { service } = await fixture(fetcher);
    await service.save({ deepseekApiKey: "deepseek-secret" });
    const error = await service
      .search({ query: "public advisory", mode: "web" })
      .catch((reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain("deepseek-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

test("cancels a DeepSeek HTTP request through the Agent Stop signal", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  const { service } = await fixture(fetcher);
  await service.save({ deepseekApiKey: "deepseek-secret" });
  const controller = new AbortController();
  const pending = service.search({ query: "public advisory", mode: "web" }, controller.signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const failure = expect(pending).rejects.toThrow("Web Search cancelled");
  controller.abort();
  await failure;
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
