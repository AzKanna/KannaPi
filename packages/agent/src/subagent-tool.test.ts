import { expect, test, vi } from "vitest";
import {
  createSubagentTool,
  inheritedToolProfile,
  subagentsFromResult,
  type SubagentFactory,
  type SubagentSessionPort,
} from "./subagent-tool.js";

const options = { maxConcurrency: 2, timeoutMs: 5000, parentProfile: "full" as const, model: "fake/test" };
function fixture(run: (text: string, abort: Promise<void>) => Promise<string>) {
  const created: Array<{
    agent: string;
    profile: string;
    dispose: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  }> = [];
  const factory: SubagentFactory = async (preset, profile, onEvent) => {
    const messages: unknown[] = [];
    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const session: SubagentSessionPort["session"] = {
      isStreaming: false,
      state: { messages },
      abortCompaction: vi.fn(),
      abort: vi.fn(async () => {
        resolveAbort();
      }),
      async prompt(text) {
        session.isStreaming = true;
        try {
          onEvent({ type: "tool_execution_start", toolName: "read" });
          const output = await run(text, aborted);
          const message = { role: "assistant", content: [{ type: "text", text: output }] };
          messages.push(message);
          onEvent({ type: "message_end", message });
        } finally {
          session.isStreaming = false;
        }
      },
    };
    const dispose = vi.fn(async () => undefined);
    created.push({ agent: preset.name, profile, dispose, abort: session.abort as ReturnType<typeof vi.fn> });
    return { session, dispose };
  };
  return { factory, created };
}
async function execute(tool: ReturnType<typeof createSubagentTool>, params: object, signal?: AbortSignal) {
  const updates: unknown[] = [];
  const result = await tool.execute(
    "call",
    params,
    signal,
    (update) => {
      updates.push(update);
    },
    {} as never,
  );
  return { result, updates, agents: subagentsFromResult(result)! };
}

test("parallel delegation runs concurrently within its cap, isolates failures and disposes every session", async () => {
  let active = 0,
    maximum = 0;
  const f = fixture(async (text) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    if (text === "fail") throw new Error("failure in one child");
    return `verified ${text}`;
  });
  const { result, updates, agents } = await execute(createSubagentTool(f.factory, options), {
    tasks: ["first", "fail", "third", "fourth"].map((task) => ({ agent: "scout", task })),
  });
  expect(maximum).toBe(2);
  expect(agents.map((agent) => agent.status)).toEqual(["completed", "failed", "completed", "completed"]);
  expect(agents[1]?.error).toBe("failure in one child");
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("3/4 completed") });
  expect(subagentsFromResult(updates[0])?.every((item) => item.status === "queued")).toBe(true);
  expect(f.created).toHaveLength(4);
  for (const child of f.created) expect(child.dispose).toHaveBeenCalledOnce();
});

test("chains pass prior text, stop on a failed step and do not start later sessions", async () => {
  const seen: string[] = [];
  const f = fixture(async (text) => {
    seen.push(text);
    if (text.includes("reject")) throw new Error("plan failed");
    return "evidence from scout";
  });
  const { agents } = await execute(createSubagentTool(f.factory, options), {
    chain: [
      { agent: "scout", task: "inspect" },
      { agent: "planner", task: "reject based on {previous}" },
      { agent: "worker", task: "implement {previous}" },
    ],
  });
  expect(seen).toEqual(["inspect", "reject based on evidence from scout"]);
  expect(agents.map((item) => item.status)).toEqual(["completed", "failed", "skipped"]);
  expect(f.created).toHaveLength(2);
});

test("cancellation aborts running children, never starts queued ones and waits for cleanup", async () => {
  const f = fixture(async (_text, aborted) => {
    await aborted;
    throw new Error("cancelled");
  });
  const controller = new AbortController();
  const pending = execute(
    createSubagentTool(f.factory, options),
    { tasks: Array.from({ length: 4 }, () => ({ agent: "worker", task: "wait" })) },
    controller.signal,
  );
  await vi.waitFor(() => expect(f.created).toHaveLength(2));
  controller.abort();
  const { agents } = await pending;
  expect(agents.every((item) => item.status === "stopped")).toBe(true);
  expect(f.created).toHaveLength(2);
  for (const child of f.created) {
    expect(child.abort).toHaveBeenCalledOnce();
    expect(child.dispose).toHaveBeenCalledOnce();
  }
});

test("timeout aborts a task and reports failure; role tool access cannot exceed the parent", async () => {
  const f = fixture(async (_text, aborted) => {
    await aborted;
    throw new Error("cancelled");
  });
  const { agents } = await execute(
    createSubagentTool(f.factory, { ...options, timeoutMs: 25, parentProfile: "workspace" }),
    { agent: "worker", task: "wait" },
  );
  expect(agents[0]).toMatchObject({
    status: "failed",
    error: "Subagent timed out",
    toolProfile: "workspace",
  });
  expect(f.created[0]?.abort).toHaveBeenCalledOnce();
  expect(inheritedToolProfile("read-only", "full")).toBe("read-only");
  expect(inheritedToolProfile("full", "read-only")).toBe("read-only");
});

test("invalid and ambiguous modes are rejected before creating a session", async () => {
  const f = fixture(async () => "done");
  const tool = createSubagentTool(f.factory, options);
  await expect(
    execute(tool, { agent: "scout", task: "inspect", tasks: [{ agent: "scout", task: "other" }] }),
  ).rejects.toThrow("exactly one");
  await expect(execute(tool, { tasks: [] })).rejects.toThrow("1–8");
  await expect(execute(tool, { agent: "missing", task: "inspect" })).rejects.toThrow("Invalid");
  expect(f.created).toHaveLength(0);
});
