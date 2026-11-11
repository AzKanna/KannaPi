import { setTimeout as delay } from "node:timers/promises";
import type { BrowserAction, BrowserActionType, Correlator, KannaEvent } from "@kanna/shared";
import { CORRELATION, newId, TRAFFIC_EXPECTING_ACTION_TYPES } from "@kanna/shared";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import type { EvidenceStore } from "./evidence-store.js";
import { PageEventRecorder } from "./page-event-recorder.js";

export interface ActionRepository {
  save(action: BrowserAction): void;
  get(id: string): BrowserAction | undefined;
}

export interface BrowserSessionOptions {
  sessionId: string;
  actions: ActionRepository;
  correlator: Pick<Correlator, "actionStarted" | "actionEnded" | "recordPageEvent">;
  evidenceStore: EvidenceStore;
  proxyServer?: string;
  emit?: (event: KannaEvent) => void;
  zeroFlowCheckDelayMs?: number;
  settleNetworkIdleTimeoutMs?: number;
  settleQuietPeriodMs?: number;
  headless?: boolean;
}

export interface PageSnapshot {
  actionId: string;
  url: string;
  title: string;
  text?: string;
  links?: Array<{ text: string; href: string }>;
  inputs?: Array<{ name: string; type: string; value?: string; placeholder?: string }>;
  forms?: Array<{
    action: string;
    method: string;
    fields: Array<{ name: string; type: string; value?: string }>;
  }>;
}

export type PageInclude = "text" | "forms" | "links" | "inputs";

export class BrowserSession {
  readonly pageId = newId("pg");
  private seq = 0;
  private activeActionId?: string;
  private readonly recorder: PageEventRecorder;
  private closed = false;

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly options: BrowserSessionOptions,
  ) {
    this.recorder = new PageEventRecorder(page, options.correlator, () => this.activeActionId);
    this.recorder.start();
  }

  static async launch(options: BrowserSessionOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    try {
      const context = await browser.newContext({
        proxy: options.proxyServer ? { server: options.proxyServer } : undefined,
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
      });
      return new BrowserSession(browser, context, await context.newPage(), options);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  navigate(url: string): Promise<BrowserAction> {
    return this.actionOnly("navigate", { url }, () => this.page.goto(url));
  }

  click(selector: string, options: { text?: string; timeoutMs?: number } = {}): Promise<BrowserAction> {
    const locator = options.text
      ? this.page.locator(selector, { hasText: options.text })
      : this.page.locator(selector);
    return this.actionOnly("click", { selector, ...(options.text ? { text: options.text } : {}) }, () =>
      locator.click({ timeout: options.timeoutMs }),
    );
  }

  type(selector: string, text: string, submit = false): Promise<BrowserAction> {
    return this.actionOnly(submit ? "submit" : "type", { selector, text: "[redacted]", submit }, async () => {
      await this.page.locator(selector).fill(text);
      if (submit) await this.page.locator(selector).press("Enter");
    });
  }

  pressKey(key: string): Promise<BrowserAction> {
    return this.actionOnly("press_key", { key }, () => this.page.keyboard.press(key));
  }

  back(): Promise<BrowserAction> {
    return this.actionOnly("back", {}, () => this.page.goBack());
  }
  reload(): Promise<BrowserAction> {
    return this.actionOnly("reload", {}, () => this.page.reload());
  }

  wait(options: { selector?: string; text?: string; timeoutMs?: number }): Promise<BrowserAction> {
    if (!options.selector && !options.text) throw new Error("wait requires selector or text");
    return this.actionOnly("wait", options, async () => {
      if (options.selector) await this.page.locator(options.selector).waitFor({ timeout: options.timeoutMs });
      else await this.page.getByText(options.text as string).waitFor({ timeout: options.timeoutMs });
    });
  }

  async screenshot(fullPage = false): Promise<{ actionId: string; path: string }> {
    const { action, result } = await this.runAction("screenshot", { fullPage }, (actionId) =>
      this.options.evidenceStore.capture(this.page, actionId, fullPage),
    );
    return { actionId: action.id, path: result };
  }

  async getPage(include: PageInclude[] = ["text", "forms", "links", "inputs"]): Promise<PageSnapshot> {
    const { action, result } = await this.runAction("get_page", { include }, async () =>
      this.page.evaluate((keys) => {
        const selected = new Set(keys);
        const data: Omit<PageSnapshot, "actionId"> = { url: location.href, title: document.title };
        if (selected.has("text")) data.text = (document.body?.innerText ?? "").slice(0, 16_000);
        if (selected.has("links"))
          data.links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
            .slice(0, 50)
            .map((a) => ({ text: (a.innerText || a.textContent || "").trim().slice(0, 200), href: a.href }));
        if (selected.has("inputs"))
          data.inputs = [...document.querySelectorAll<HTMLInputElement>("input,textarea,select")]
            .slice(0, 50)
            .map((input) => ({
              name: input.getAttribute("name") ?? "",
              type: input.getAttribute("type") ?? input.tagName.toLowerCase(),
              value: input.value.slice(0, 200),
              placeholder: input.getAttribute("placeholder") ?? undefined,
            }));
        if (selected.has("forms"))
          data.forms = [...document.forms].slice(0, 20).map((form) => ({
            action: form.action,
            method: form.method.toUpperCase(),
            fields: [...form.elements]
              .filter((e): e is HTMLInputElement => "name" in e)
              .slice(0, 50)
              .map((e) => ({
                name: e.getAttribute("name") ?? "",
                type: e.getAttribute("type") ?? e.tagName.toLowerCase(),
                value: e.value.slice(0, 200),
              })),
          }));
        return data;
      }, include),
    );
    return { actionId: action.id, ...result };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.recorder.stop();
    await this.context.close();
    await this.browser.close();
  }

  private async actionOnly(
    type: BrowserActionType,
    params: Record<string, unknown>,
    fn: (actionId: string) => Promise<unknown>,
  ): Promise<BrowserAction> {
    return (await this.runAction(type, params, fn)).action;
  }

  private async runAction<T>(
    type: BrowserActionType,
    params: Record<string, unknown>,
    fn: (actionId: string) => Promise<T>,
  ): Promise<{ action: BrowserAction; result: T }> {
    if (this.closed) throw new Error("browser session is closed");
    const action: BrowserAction = {
      id: newId("act"),
      sessionId: this.options.sessionId,
      seq: ++this.seq,
      type,
      params,
      pageId: this.pageId,
      startedAt: Date.now(),
      status: "running",
      correlatedFlowIds: [],
      pageUrlBefore: this.page.url() || undefined,
    };
    this.options.actions.save(action);
    this.options.correlator.actionStarted({
      actionId: action.id,
      pageId: action.pageId,
      startedAt: action.startedAt,
    });
    this.activeActionId = action.id;
    try {
      const result = await fn(action.id);
      await this.settle();
      action.endedAt = Date.now();
      action.status = "completed";
      action.pageUrlAfter = this.page.url() || undefined;
      return { action: this.finish(action), result };
    } catch (error) {
      action.endedAt = Date.now();
      action.status = "failed";
      action.error = error instanceof Error ? error.message : String(error);
      action.pageUrlAfter = this.page.url() || undefined;
      this.finish(action);
      throw error;
    } finally {
      this.activeActionId = undefined;
    }
  }

  private finish(action: BrowserAction): BrowserAction {
    this.options.correlator.actionEnded(action.id, action.endedAt as number);
    const persisted = this.options.actions.get(action.id);
    action.correlatedFlowIds = [
      ...new Set([...action.correlatedFlowIds, ...(persisted?.correlatedFlowIds ?? [])]),
    ];
    this.options.actions.save(action);
    this.options.emit?.({ type: "action", action });
    if (action.status === "completed" && TRAFFIC_EXPECTING_ACTION_TYPES.includes(action.type))
      void this.checkForZeroFlow(action.id, action.type);
    return action;
  }

  private async settle(): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", {
        timeout: this.options.settleNetworkIdleTimeoutMs ?? CORRELATION.settleNetworkIdleTimeoutMs,
      });
    } catch {
      /* long-polling and non-navigation actions may never become idle */
    }
    await delay(this.options.settleQuietPeriodMs ?? CORRELATION.settleQuietPeriodMs);
  }

  private async checkForZeroFlow(actionId: string, type: BrowserActionType): Promise<void> {
    await delay(this.options.zeroFlowCheckDelayMs ?? 1_000);
    const latest = this.options.actions.get(actionId);
    if (latest && latest.correlatedFlowIds.length === 0)
      this.options.emit?.({
        type: "log",
        level: "warn",
        message: `No traffic attributed to ${type} action`,
        detail: { actionId },
      });
  }
}
