import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "playwright";

export class EvidenceStore {
  constructor(readonly directory: string) {}

  async capture(page: Page, actionId: string, fullPage = false): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const path = resolve(this.directory, `${actionId}.png`);
    await page.screenshot({ path, fullPage });
    return path;
  }
}
