import { describe, expect, test } from "vitest";
import { clampSidebarWidth, sidebarWidthBounds } from "./workspace-layout.js";

describe("workspace sidebar resizing", () => {
  test("keeps enough room for the chat and inspector on a wide desktop", () => {
    expect(sidebarWidthBounds(1_200)).toEqual({ min: 184, max: 358 });
    expect(clampSidebarWidth(500, 1_200)).toBe(358);
  });

  test("allows the navigation pane to shrink so the chat can grow", () => {
    expect(clampSidebarWidth(100, 1_440)).toBe(184);
    expect(clampSidebarWidth(300, 1_440)).toBe(300);
  });

  test("uses the compact layout bounds after the inspector is hidden", () => {
    expect(sidebarWidthBounds(1_000)).toEqual({ min: 184, max: 420 });
  });
});
