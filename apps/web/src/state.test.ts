import { describe, expect, test } from "vitest";
import { initialState, reduceEvent } from "./state.js";

describe("Agent workspace reducer", () => {
  test("updates child progress in the owning tool without creating messages or resetting its start time", () => {
    const subagent = { id: "delegate-1", agent: "scout", task: "Inspect", status: "running" as const,
      model: "fake/test", toolProfile: "read-only" as const, text: "Checking files", toolCount: 1, transcript: [] };
    const running = reduceEvent(initialState, { type: "agent_tool", agentId: "agent_1", sessionId: "chat_1", phase: "start", toolCallId: "delegate", toolName: "subagent", subagents: [subagent] });
    const updated = reduceEvent(running, { type: "agent_tool", agentId: "agent_1", sessionId: "chat_1", phase: "start", toolCallId: "delegate", toolName: "subagent", subagents: [{ ...subagent, text: "Found source files" }] });
    expect(updated.tools.chat_1).toHaveLength(1);
    expect(updated.tools.chat_1?.[0]?.startedAt).toBe(running.tools.chat_1?.[0]?.startedAt);
    expect(updated.tools.chat_1?.[0]?.subagents?.[0]?.text).toBe("Found source files");
    expect(updated.messages.chat_1).toBeUndefined();
    expect(updated.tools.chat_2).toBeUndefined();
  });
  test("keeps context compression progress isolated by Session", () => {
    const context = { tokens: 3000, contextWindow: 8000, percent: 37.5, compacting: true, compactions: 0, sandboxEnabled: true };
    const updated = reduceEvent(initialState, { type: "agent_context", agentId: "agent_1", sessionId: "chat_1", context });
    expect(updated.contexts.chat_1).toEqual(context);
    expect(updated.contexts.chat_2).toBeUndefined();
    const done = reduceEvent(updated, { type: "agent_context", agentId: "agent_1", sessionId: "chat_1", context: { ...context, compacting: false, compactions: 1, tokens: null, percent: null } });
    expect(done.contexts.chat_1?.compacting).toBe(false);
    expect(done.contexts.chat_1?.tokens).toBeNull();
  });
  test("collects streamed assistant text and replaces it with the completed message", () => {
    const first = reduceEvent(initialState, { type: "agent_delta", agentId: "agent_1", delta: "Hel" });
    const second = reduceEvent(first, { type: "agent_delta", agentId: "agent_1", delta: "lo" });
    expect(second.streaming.agent_1).toBe("Hello");
    const done = reduceEvent(second, { type: "agent_message", agentId: "agent_1", message: { role: "assistant", text: "Hello" } });
    expect(done.streaming.agent_1).toBe("");
    expect(done.messages.agent_1).toEqual([{ role: "assistant", text: "Hello" }]);
  });

  test("isolates streamed messages by chat session", () => {
    const first = reduceEvent(initialState, { type: "agent_delta", agentId: "agent_1", sessionId: "chat_1", delta: "First" });
    const second = reduceEvent(first, { type: "agent_delta", agentId: "agent_1", sessionId: "chat_2", delta: "Second" });
    expect(second.streaming.chat_1).toBe("First");
    expect(second.streaming.chat_2).toBe("Second");
  });

  test("upserts Agent status without duplicating it", () => {
    const agent = { id: "agent_1", projectId: "prj_1", name: "Agent", providerId: "p", modelId: "m", thinkingLevel: "medium" as const, cwd: "C:/x", systemPrompt: "help", toolProfile: "read-only" as const, status: "idle" as const, createdAt: 1, updatedAt: 1 };
    const idle = reduceEvent(initialState, { type: "agent_status", agent });
    const running = reduceEvent(idle, { type: "agent_status", agent: { ...agent, status: "running", updatedAt: 2 } });
    expect(running.agents).toHaveLength(1);
    expect(running.agents[0]?.status).toBe("running");
  });

  test("keeps shell command details and replaces them with failure output", () => {
    const started = reduceEvent(initialState, {
      type: "agent_tool",
      agentId: "agent_1",
      phase: "start",
      toolCallId: "call_1",
      toolName: "powershell",
      detail: "Invoke-WebRequest https://example.test",
    });
    const ended = reduceEvent(started, {
      type: "agent_tool",
      agentId: "agent_1",
      phase: "end",
      toolCallId: "call_1",
      toolName: "powershell",
      isError: true,
      detail: "Connection refused",
    });
    expect(ended.tools.agent_1?.[0]).toMatchObject({
      phase: "end",
      isError: true,
      detail: "Connection refused",
    });
  });

  test("starts a fresh session run and keeps tool progress separate from model text", () => {
    const previous = reduceEvent(initialState, { type: "agent_tool", agentId: "agent_1", sessionId: "chat_1", phase: "end", toolCallId: "old", toolName: "read" });
    const started = reduceEvent(previous, { type: "agent_chat_run", agentId: "agent_1", sessionId: "chat_1", status: "running", at: 1_000 });
    expect(started.tools.chat_1).toEqual([]);
    expect(started.runs.chat_1).toMatchObject({ status: "running", startedAt: 1_000 });
    const tool = reduceEvent(started, { type: "agent_tool", agentId: "agent_1", sessionId: "chat_1", phase: "start", toolCallId: "new", toolName: "bash", detail: "pwd" });
    expect(tool.tools.chat_1?.[0]?.phase).toBe("start");
    expect(tool.streaming.chat_1 ?? "").toBe("");
    const otherSession = reduceEvent(tool, { type: "agent_chat_run", agentId: "agent_1", sessionId: "chat_2", status: "running", at: 2_000 });
    expect(otherSession.tools.chat_1?.[0]?.toolCallId).toBe("new");
    expect(otherSession.tools.chat_2).toEqual([]);
    const done = reduceEvent(otherSession, { type: "agent_chat_run", agentId: "agent_1", sessionId: "chat_1", status: "idle", at: 3_000 });
    expect(done.runs.chat_1).toMatchObject({ status: "idle", startedAt: 1_000, endedAt: 3_000 });
  });

  test("does not append a late local echo after the model has already started replying", () => {
    const received = reduceEvent(initialState, { type: "agent_message", agentId: "agent_1", sessionId: "chat_1", message: { role: "user", text: "Read the note", timestamp: 1_000 } });
    const replied = reduceEvent(received, { type: "agent_message", agentId: "agent_1", sessionId: "chat_1", message: { role: "assistant", text: "I will check it." } });
    const echoed = reduceEvent(replied, { type: "agent_message", agentId: "agent_1", sessionId: "chat_1", message: { role: "user", text: "Read the note", timestamp: 1_050 } });
    expect(echoed.messages.chat_1?.map((message) => message.role)).toEqual(["user", "assistant"]);
    const anotherTurn = reduceEvent(echoed, { type: "agent_message", agentId: "agent_1", sessionId: "chat_1", message: { role: "user", text: "Read the note", timestamp: 3_000 } });
    expect(anotherTurn.messages.chat_1?.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  test("keeps repeated attachment-only messages when their attachment ids differ", () => {
    const attachment = (id: string) => ({
      id,
      agentId: "agent_1",
      name: `${id}.txt`,
      mimeType: "text/plain",
      size: 1,
      createdAt: 1,
    });
    const first = reduceEvent(initialState, {
      type: "agent_message",
      agentId: "agent_1",
      message: { role: "user", text: "", attachments: [attachment("att_1")] },
    });
    const second = reduceEvent(first, {
      type: "agent_message",
      agentId: "agent_1",
      message: { role: "user", text: "", attachments: [attachment("att_2")] },
    });
    expect(second.messages.agent_1).toHaveLength(2);
  });

  test("stores live Attack Graph snapshots by Agent", () => {
    const graph = {
      agentId: "agent_1",
      runId: "run_1",
      status: "completed" as const,
      startedAt: 1,
      completedAt: 2,
      nodes: [{ id: "node_1", kind: "objective" as const, title: "Objective", status: "completed" as const, timestamp: 1 }],
      edges: [],
    };
    const state = reduceEvent(initialState, { type: "agent_graph", graph });
    expect(state.graphs.agent_1).toEqual(graph);
  });
});
