import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum, type AgentToolProfile, type SubagentActivity } from "@kanna/shared";
import { Type } from "typebox";

export const SUBAGENT_PRESETS = [
  {
    name: "scout",
    description: "Read-only reconnaissance and evidence collection",
    toolProfile: "read-only",
    prompt:
      "You are Scout. Quickly inspect the task, collect relevant facts and file references, and return a concise evidence-backed handoff. Do not modify files.",
  },
  {
    name: "planner",
    description: "Create a concrete plan from collected evidence",
    toolProfile: "read-only",
    prompt:
      "You are Planner. Inspect necessary context and produce a concrete ordered plan, dependencies, assumptions and verification criteria. Do not modify files or claim to execute the plan.",
  },
  {
    name: "reviewer",
    description: "Independently review results and identify problems",
    toolProfile: "read-only",
    prompt:
      "You are Reviewer. Review the supplied work independently. Report concrete issues with evidence, severity and suggested verification. Distinguish confirmed issues from uncertainty. Do not modify files.",
  },
  {
    name: "worker",
    description: "Implement a bounded task using enabled tools",
    toolProfile: "full",
    prompt:
      "You are Worker. Complete the specified task using only your available tools, then report changes and verification honestly. Preserve unrelated work. During parallel tasks, work only on your assigned files and do not overwrite another worker's changes.",
  },
] as const;
export type SubagentPreset = (typeof SUBAGENT_PRESETS)[number];

export interface SubagentSessionPort {
  session: {
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    abortCompaction(): void;
    isStreaming: boolean;
    state: { messages: readonly unknown[] };
  };
  dispose(): Promise<void>;
}
export interface SubagentOptions {
  maxConcurrency: number;
  timeoutMs: number;
  parentProfile: AgentToolProfile;
  model: string;
}
export type SubagentFactory = (
  preset: SubagentPreset,
  profile: AgentToolProfile,
  onEvent: (event: unknown) => void,
) => Promise<SubagentSessionPort>;

const PROFILES: AgentToolProfile[] = ["chat", "read-only", "workspace", "full"];
export function inheritedToolProfile(
  parent: AgentToolProfile,
  requested: AgentToolProfile,
): AgentToolProfile {
  return PROFILES[Math.min(PROFILES.indexOf(parent), PROFILES.indexOf(requested))]!;
}

const Task = Type.Object(
  {
    agent: StringEnum(["scout", "planner", "reviewer", "worker"] as const),
    task: Type.String({
      minLength: 1,
      maxLength: 16000,
      description:
        "Self-contained task; child does not inherit conversation history. In chains use {previous} for the prior result.",
    }),
  },
  { additionalProperties: false },
);
const Parameters = Type.Object(
  {
    agent: Type.Optional(Task.properties.agent),
    task: Type.Optional(Task.properties.task),
    tasks: Type.Optional(Type.Array(Task, { minItems: 1, maxItems: 8 })),
    chain: Type.Optional(Type.Array(Task, { minItems: 1, maxItems: 8 })),
  },
  { additionalProperties: false },
);

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) =>
          part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n")
    : "";
}

/** Extract only our bounded, public progress records, including from persisted Pi tool results. */
export function subagentsFromResult(result: unknown): SubagentActivity[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: { subagents?: unknown } }).details;
  if (!Array.isArray(details?.subagents)) return undefined;
  return details.subagents
    .filter((row): row is SubagentActivity =>
      Boolean(
        row &&
          typeof row === "object" &&
          typeof row.id === "string" &&
          typeof row.agent === "string" &&
          typeof row.text === "string" &&
          Array.isArray(row.transcript),
      ),
    )
    .slice(0, 8);
}

/** Pi H06 same-process sessions: independent context, explicit cwd, bounded fan-out and cleanup. */
export function createSubagentTool(factory: SubagentFactory, options: SubagentOptions): ToolDefinition {
  if (
    !Number.isInteger(options.maxConcurrency) ||
    options.maxConcurrency < 1 ||
    options.maxConcurrency > 4 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 1
  )
    throw new Error("Invalid subagent limits");
  return defineTool({
    name: "subagent",
    label: "Subagents",
    executionMode: "sequential",
    description: `Delegate to independent Pi agents: scout (read-only facts), planner (read-only plan), reviewer (read-only review), worker (implementation). Use exactly one mode: {agent,task}, {tasks:[{agent,task}]} for parallel work, or {chain:[{agent,task}]} with {previous} for sequential handoffs. Maximum 8 tasks and ${options.maxConcurrency} concurrent sessions. Children inherit this model, workspace and tool permission ceiling; no nested delegation. Results are returned to you for synthesis.`,
    promptSnippet:
      "Delegate self-contained tasks to Scout, Planner, Reviewer or Worker in single, parallel or chain mode.",
    promptGuidelines: [
      "Use parallel delegation for independent tasks; assign disjoint files to workers.",
      "Child agents have no parent conversation history. Include all relevant context in task text.",
      "Use {previous} in chain task text to pass the prior result. Validate delegated results before reporting success.",
    ],
    parameters: Parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      const single = params.agent !== undefined || params.task !== undefined;
      if (Number(single) + Number(params.tasks !== undefined) + Number(params.chain !== undefined) !== 1)
        throw new Error("Choose exactly one subagent mode: agent/task, tasks, or chain");
      if (single && (!params.agent || !params.task?.trim()))
        throw new Error("Single mode requires agent and task");
      const mode = params.chain ? "chain" : params.tasks ? "parallel" : "single";
      const tasks = params.chain ?? params.tasks ?? [{ agent: params.agent!, task: params.task! }];
      if (!tasks.length || tasks.length > 8) throw new Error("Subagent batches require 1–8 tasks");
      const states: SubagentActivity[] = tasks.map((item, index) => {
        const preset = SUBAGENT_PRESETS.find((preset) => preset.name === item.agent);
        if (!preset || !item.task.trim() || item.task.length > 16000)
          throw new Error("Invalid subagent task");
        return {
          id: `${toolCallId}-${index + 1}`,
          agent: item.agent,
          task: item.task,
          status: "queued",
          model: options.model,
          toolProfile: inheritedToolProfile(options.parentProfile, preset.toolProfile),
          text: "",
          toolCount: 0,
          transcript: [],
        };
      });
      let lastUpdate = 0;
      const publish = (force = false) => {
        if (!force && Date.now() - lastUpdate < 250) return;
        lastUpdate = Date.now();
        onUpdate?.({
          content: [
            {
              type: "text",
              text: states
                .map(
                  (state) => `${state.agent}: ${state.status}${state.lastTool ? ` · ${state.lastTool}` : ""}`,
                )
                .join("\n"),
            },
          ],
          details: {
            mode,
            subagents: structuredClone(
              states.map((state) => ({ ...state, transcript: state.transcript.slice(-4) })),
            ),
          },
        });
      };
      publish(true);
      // Keep the owning chat's idle watchdog informed while a child's command
      // runs without model deltas; the task timeout still bounds execution.
      const heartbeat = setInterval(() => publish(), 10000);
      heartbeat.unref();
      const run = async (index: number, taskText: string) => {
        const state = states[index]!;
        const preset = SUBAGENT_PRESETS.find((preset) => preset.name === state.agent)!;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
        let wrapper: SubagentSessionPort | undefined;
        const abort = () => {
          wrapper?.session.abortCompaction();
          void wrapper?.session.abort().catch(() => undefined);
        };
        combined.addEventListener("abort", abort, { once: true });
        try {
          if (combined.aborted) throw new Error("Subagent cancelled");
          state.status = "running";
          state.startedAt = Date.now();
          publish(true);
          wrapper = await factory(preset, state.toolProfile, (event) => {
            if (!event || typeof event !== "object") return;
            const value = event as Record<string, unknown>;
            if (value.type === "message_start" && (value.message as { role?: string })?.role === "assistant")
              state.text = "";
            if (value.type === "message_update") {
              const delta = value.assistantMessageEvent as { type?: string; delta?: string } | undefined;
              if (delta?.type === "text_delta")
                state.text = `${state.text}${delta.delta ?? ""}`.slice(0, 50000);
            } else if (value.type === "tool_execution_start") {
              state.toolCount += 1;
              state.lastTool = String(value.toolName ?? "tool");
            } else if (value.type === "message_end" && value.message && typeof value.message === "object") {
              const message = value.message as Record<string, unknown>;
              const text = messageText(message).slice(0, 50000);
              if (message.role === "assistant") {
                state.text = text;
                state.error =
                  message.stopReason === "error"
                    ? String(message.errorMessage ?? "Model request failed").slice(0, 2000)
                    : undefined;
                if (text) state.transcript.push({ role: "assistant", text: text.slice(0, 2000) });
              } else if (message.role === "toolResult") {
                state.transcript.push({
                  role: "tool",
                  text: text.slice(0, 2000),
                  toolName: String(message.toolName ?? "tool"),
                  isError: Boolean(message.isError),
                });
              }
              state.transcript = state.transcript.slice(-16);
            }
            publish();
          });
          if (combined.aborted) throw new Error("Subagent cancelled");
          // Session.prompt resolves after Pi retries, compaction and tool execution settle.
          await wrapper.session.prompt(taskText);
          if (combined.aborted)
            throw new Error(timeout.signal.aborted ? "Subagent timed out" : "Subagent cancelled");
          if (state.error) throw new Error(state.error);
          const last = [...wrapper.session.state.messages]
            .reverse()
            .find(
              (message) =>
                message && typeof message === "object" && (message as { role?: string }).role === "assistant",
            );
          if (last) state.text = messageText(last as Record<string, unknown>).slice(0, 50000);
          state.status = "completed";
        } catch (error) {
          state.status = combined.aborted && !timeout.signal.aborted ? "stopped" : "failed";
          state.error = timeout.signal.aborted
            ? "Subagent timed out"
            : error instanceof Error
              ? error.message.slice(0, 2000)
              : String(error).slice(0, 2000);
        } finally {
          clearTimeout(timer);
          combined.removeEventListener("abort", abort);
          if (wrapper) {
            if (wrapper.session.isStreaming) await wrapper.session.abort().catch(() => undefined);
            await wrapper.dispose().catch(() => undefined);
          }
          state.endedAt = Date.now();
          publish(true);
        }
      };
      try {
        if (mode === "chain") {
          let previous = "";
          for (let index = 0; index < states.length; index++) {
            await run(index, tasks[index]!.task.replaceAll("{previous}", previous));
            if (states[index]!.status !== "completed") {
              for (const state of states.slice(index + 1)) state.status = "skipped";
              break;
            }
            previous = states[index]!.text;
          }
        } else {
          let cursor = 0;
          await Promise.all(
            Array.from({ length: Math.min(options.maxConcurrency, states.length) }, async () => {
              while (cursor < states.length) {
                const index = cursor++;
                await run(index, tasks[index]!.task);
              }
            }),
          );
        }
        const succeeded = states.filter((state) => state.status === "completed").length;
        const failed = succeeded !== states.length;
        const output =
          mode === "chain" && !failed
            ? states.at(-1)!.text
            : states
                .map(
                  (state) =>
                    `### ${state.agent} · ${state.status}\n${state.error ?? (state.text || "No text response")}`,
                )
                .join("\n\n");
        const text = `${mode}: ${succeeded}/${states.length} completed${failed ? " (some tasks did not complete)" : ""}\n\n${output}`;
        return {
          content: [
            {
              type: "text",
              text:
                text.length > 50000
                  ? `${text.slice(0, 50000)}\n[Output truncated; individual results are saved in details.]`
                  : text,
            },
          ],
          details: { mode, failed, subagents: structuredClone(states) },
        };
      } finally {
        clearInterval(heartbeat);
      }
    },
  });
}
