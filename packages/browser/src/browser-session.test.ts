import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserAction, KannaEvent } from "@kanna/shared";
import { Correlator } from "@kanna/shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { BrowserSession, EvidenceStore } from "./index.js";

class MemoryActions {
  readonly values = new Map<string, BrowserAction>();
  save(action: BrowserAction): void {
    this.values.set(action.id, structuredClone(action));
  }
  get(id: string): BrowserAction | undefined {
    return this.values.get(id);
  }
}

class BackfillingActions extends MemoryActions {
  override save(action: BrowserAction): void {
    super.save(action);
    if (action.status === "running") {
      const stored = this.values.get(action.id);
      if (stored) stored.correlatedFlowIds = ["flow_arrived_during_action"];
    }
  }
}

describe("BrowserSession", () => {
  let server: Server;
  let baseUrl: string;
  let evidenceDir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/api?q=kanna") {
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><title>Kanna Test</title>
        <a href="/next">Next</a>
        <form><input name="q"><button type="submit">Search</button></form>
        <script>document.querySelector('form').addEventListener('submit', e => {
          e.preventDefault(); fetch('/api?q=' + encodeURIComponent(document.querySelector('input').value));
        })</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    evidenceDir = await mkdtemp(join(tmpdir(), "kanna-evidence-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    await rm(evidenceDir, { recursive: true, force: true });
  });

  test("records bounded page data, request events and completed actions", async () => {
    const actions = new MemoryActions();
    const correlator = new Correlator();
    const recordPageEvent = vi.spyOn(correlator, "recordPageEvent");
    const events: KannaEvent[] = [];
    const browser = await BrowserSession.launch({
      sessionId: "sess_test",
      actions,
      correlator,
      evidenceStore: new EvidenceStore(evidenceDir),
      emit: (event) => events.push(event),
      zeroFlowCheckDelayMs: 10,
      settleQuietPeriodMs: 0,
    });
    try {
      const navigation = await browser.navigate(baseUrl);
      expect(navigation.status).toBe("completed");
      expect(navigation.pageUrlAfter).toBe(`${baseUrl}/`);

      await browser.type("input[name=q]", "kanna");
      const submit = await browser.click("button[type=submit]");
      expect(submit.seq).toBe(3);
      expect(recordPageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: `${baseUrl}/api?q=kanna`,
        }),
      );

      const page = await browser.getPage(["text", "forms", "links", "inputs"]);
      expect(page.title).toBe("Kanna Test");
      expect(page.links).toHaveLength(1);
      expect(page.forms?.[0]?.fields[0]?.name).toBe("q");

      const shot = await browser.screenshot();
      expect((await readFile(shot.path)).byteLength).toBeGreaterThan(0);
      expect([...actions.values.values()].every((a) => a.status === "completed")).toBe(true);
      expect(events.some((e) => e.type === "action")).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test("persists a failed action and rethrows the browser error", async () => {
    const actions = new MemoryActions();
    const browser = await BrowserSession.launch({
      sessionId: "sess_failed",
      actions,
      correlator: new Correlator(),
      evidenceStore: new EvidenceStore(evidenceDir),
      settleQuietPeriodMs: 0,
    });
    try {
      await expect(browser.click("#missing", { timeoutMs: 20 })).rejects.toThrow();
      expect([...actions.values.values()][0]).toMatchObject({ status: "failed", seq: 1 });
    } finally {
      await browser.close();
    }
  });

  test("preserves flow ids backfilled while an action is still running", async () => {
    const actions = new BackfillingActions();
    const browser = await BrowserSession.launch({
      sessionId: "sess_race",
      actions,
      correlator: new Correlator(),
      evidenceStore: new EvidenceStore(evidenceDir),
      settleQuietPeriodMs: 0,
    });
    try {
      const action = await browser.navigate(baseUrl);
      expect(action.correlatedFlowIds).toEqual(["flow_arrived_during_action"]);
    } finally {
      await browser.close();
    }
  });
});
