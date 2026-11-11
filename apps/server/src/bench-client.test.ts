import { expect, test, vi } from "vitest";
import { BenchClient, BenchError, benchBaseUrl, benchCode, benchToken } from "./bench-client.js";

test("validates Bench configuration and challenge codes", () => {
  expect(benchBaseUrl("https://bench.example.test///")).toBe("https://bench.example.test");
  expect(benchToken(" token-test ")).toBe("token-test");
  expect(benchCode("web_001")).toBe("web_001");
  for (const value of ["ftp://bench.example.test", "https://user:pass@bench.example.test", "https://bench.example.test/?x=1"])
    expect(() => benchBaseUrl(value)).toThrow();
  expect(() => benchToken("secret token")).toThrow();
  expect(() => benchCode("web\n001")).toThrow();
});

test("uses the TSec SDK 0.1.2 routes and never sends token to VPN health check", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "http://192.0.2.100") return Response.json({ status: "ok", client_ip: "10.0.0.2" });
    if (String(url).endsWith("/openapi/v1/challenges"))
      return Response.json([
        {
          unique_code: "web_001",
          description: "demo",
          difficulty: "easy",
          level: 1,
          total_score: 10,
          flag_count: 1,
          correct_flag_count: 0,
          is_completed: false,
          container_status: "stopped",
          container_addr: [],
        },
      ]);
    if (String(url).endsWith("/openapi/v1/challenges/start?unique_code=web_001"))
      return Response.json({ unique_code: "web_001", container_addr: ["10.0.0.8:8080"] });
    if (String(url).endsWith("/openapi/v1/challenges/submit"))
      return Response.json({ correct: true, awarded: 10, cumulative_score: 10, correct_flag_count: 1, total_flag_count: 1, matched_flag_index: 0 });
    if (String(url).endsWith("/openapi/v1/challenges/close?unique_code=web_001"))
      return Response.json({ unique_code: "web_001", closed: true });
    return Response.json({ code: "challenge_not_found" }, { status: 404 });
  });
  const client = new BenchClient("https://bench.example.test", "token-test", fetcher, "http://192.0.2.100");
  await client.checkVpn();
  const list = await client.list();
  expect(list[0]?.unique_code).toBe("web_001");
  await client.start("web_001");
  await client.submit("web_001", "FLAG{ok}");
  await client.close("web_001");
  expect(calls[0]?.init.headers).toBeUndefined();
  expect(calls.slice(1).every((call) => (call.init.headers as Record<string, string>).BENCHMARK_TOKEN === "token-test")).toBe(true);
});

test("sanitizes platform errors without reflecting arbitrary upstream messages", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url) === "http://192.0.2.100"
      ? Response.json({ status: "ok" })
      : Response.json({ code: "invalid_state", message: "token-test leaked" }, { status: 409 }),
  );
  const client = new BenchClient("https://bench.example.test", "token-test", fetcher, "http://192.0.2.100");
  await client.checkVpn();
  await expect(client.list()).rejects.toMatchObject({ code: "invalid_state" } satisfies Partial<BenchError>);
  await expect(client.list()).rejects.not.toThrow("token-test");
});
