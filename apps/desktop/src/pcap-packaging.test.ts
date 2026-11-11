import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface DesktopPackage {
  scripts: Record<string, string>;
  build: { extraResources: Array<{ from: string; to: string }> };
}

describe("desktop TShark packaging", () => {
  test("stages and bundles the verified TShark runtime", () => {
    const config = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as DesktopPackage;
    expect(config.scripts.dist).toContain("prepare:tshark");
    expect(config.build.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "build/tshark", to: "tshark" }),
    ]));
  });
});
