import { mkdirSync } from "node:fs";
import { fileURLToPath as qaFileURLToPath } from "node:url";

const qaDir = new URL("../../../.tmp/pcap-qa/", import.meta.url);
mkdirSync(qaDir, { recursive: true });

import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:4173/?workspace=pcap', { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Traffic Analysis' }).waitFor();
await page.screenshot({ path: qaFileURLToPath(new URL("pcap-ui-overview.png", qaDir)), fullPage: true });
const summary = {
  reports: await page.getByLabel('Selected PCAP capture').locator('option').count(),
  packets: await page.getByText('PACKETS', { exact: true }).count(),
  webshellTab: await page.getByRole('button', { name: /WebShell clues/ }).count(),
  sendDisabledBeforeReview: await page.getByRole('button', { name: /Send to Agent/ }).isDisabled(),
  tlsKeyLogButton: await page.getByRole('button', { name: /Import TLS key log/ }).count(),
  errors,
};
if (!summary.tlsKeyLogButton) throw new Error('TLS key log import control is missing');
await page.getByRole('button', { name: /Asset graph/ }).click();
await page.screenshot({ path: qaFileURLToPath(new URL("pcap-ui-graph.png", qaDir)), fullPage: true });
summary.graphNodes = await page.locator('.pcap-graph-node').count();
await page.getByRole('button', { name: /WebShell clues/ }).click();
summary.webshellRows = await page.locator('.pcap-list > button').count();
await page.setViewportSize({ width: 1080, height: 760 });
await page.getByRole('button', { name: /Asset graph/ }).click();
summary.desktopNarrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
await page.screenshot({ path: qaFileURLToPath(new URL("pcap-ui-narrow.png", qaDir)), fullPage: true });
console.log(JSON.stringify(summary, null, 2));
await browser.close();
