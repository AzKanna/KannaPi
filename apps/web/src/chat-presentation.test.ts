import { describe, expect, test } from "vitest";
import { groupChatTurns } from "./chat-presentation.js";

describe("chat turn presentation", () => {
  test("places tool results beneath the model's text even when tools arrived first", () => {
    const turns = groupChatTurns([
      { role: "user", text: "Read the note" },
      { role: "tool", toolName: "read", text: "note content" },
      { role: "assistant", text: "The note says hello." },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.replies.map((message) => message.text)).toEqual(["The note says hello."]);
    expect(turns[0]?.tools.map((message) => message.toolName)).toEqual(["read"]);
  });

  test("keeps tool calls inside their own user turn", () => {
    const turns = groupChatTurns([
      { role: "user", text: "First" },
      { role: "assistant", text: "Checking the file." },
      { role: "tool", toolName: "read", text: "done" },
      { role: "assistant", text: "Finished." },
      { role: "user", text: "Second" },
      { role: "assistant", text: "Another answer." },
    ]);
    expect(turns.map((turn) => turn.user?.text)).toEqual(["First", "Second"]);
    expect(turns[0]?.replies.map((message) => message.text)).toEqual(["Checking the file.", "Finished."]);
    expect(turns[0]?.tools).toHaveLength(1);
    expect(turns[1]?.tools).toHaveLength(0);
  });
});
