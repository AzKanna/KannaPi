import type { Correlator } from "@kanna/shared";
import type { Page, Request } from "playwright";

export class PageEventRecorder {
  private readonly onRequest = (request: Request): void => {
    let initiatorUrl: string | undefined;
    try {
      initiatorUrl = request.frame().url() || undefined;
    } catch {
      /* navigation request */
    }
    this.correlator.recordPageEvent({
      url: request.url(),
      method: request.method(),
      wallTime: Date.now(),
      actionId: this.currentActionId(),
      initiatorUrl,
    });
  };

  constructor(
    private readonly page: Page,
    private readonly correlator: Pick<Correlator, "recordPageEvent">,
    private readonly currentActionId: () => string | undefined,
  ) {}

  start(): void {
    this.page.on("request", this.onRequest);
  }
  stop(): void {
    this.page.off("request", this.onRequest);
  }
}
