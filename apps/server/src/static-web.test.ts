import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startPlatform } from "./platform.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("desktop static web hosting", () => {
  test("serves the built SPA and keeps API routes on the same origin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kanna-static-web-"));
    dirs.push(dir);
    const webRoot = join(dir, "web");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>KannaPi Desktop</title>");
    await writeFile(join(webRoot, "assets", "app.js"), "console.log('desktop')");
    const platform = await startPlatform({
      repoRoot: dir,
      dataDir: join(dir, "data"),
      webRoot,
      port: 0,
    });
    try {
      const base = `http://127.0.0.1:${platform.port}`;
      const home = await fetch(`${base}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await home.text()).toContain("KannaPi Desktop");

      const route = await fetch(`${base}/workspace/traffic`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain("KannaPi Desktop");

      const asset = await fetch(`${base}/assets/app.js`);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toContain("desktop");

      expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/api/health`).then((response) => response.json()))).toMatchObject({
        ok: true,
      });
    } finally {
      await platform.close();
    }
  });
});
