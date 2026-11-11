import { describe, expect, test } from "vitest";
import { isNearChatBottom } from "./chat-scroll.js";

describe("chat scroll position", () => {
  test("follows new activity when the reader is at the bottom", () => {
    expect(isNearChatBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearChatBottom({ scrollTop: 584, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  test("preserves history reading when the reader scrolls up", () => {
    expect(isNearChatBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  test("considers short conversations to already be at the bottom", () => {
    expect(isNearChatBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true);
  });
});
