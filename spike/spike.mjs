// T0 Spike — Verify Pi coding-agent SDK embedding for KannaPi.
//
// Answers (empirically):
//   Q1  noTools:"all" / "builtin" + customTools — which leaves our custom tools active?
//   Q2  models.json custom OpenAI-compatible provider → end-to-end agent loop
//   Q3  systemPrompt override via DefaultResourceLoader reaches the LLM
//   Q4  custom tool (TypeBox schema) executes and its result feeds back to the model
//   Q5  session event stream is subscribable headless
// No real API key needed: an in-process fake OpenAI SSE server is the "LLM".
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { startFakeOpenAIServer } from "./fake-server.mjs";

const CUSTOM_SYSTEM_PROMPT =
  "You are Kanna, an autonomous web security testing agent (spike). SPIKE_MARKER_KANNA.";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = await startFakeOpenAIServer();
console.log(`fake OpenAI server on 127.0.0.1:${fake.port}`);

// --- ModelRuntime with a custom provider via models.json ---
const runtimeDir = mkdtempSync(join(tmpdir(), "kanna-spike-"));
const modelsPath = join(runtimeDir, "models.json");
const authPath = join(runtimeDir, "auth.json");
writeFileSync(
  modelsPath,
  JSON.stringify(
    {
      providers: {
        "spike-fake": {
          name: "Spike Fake OpenAI",
          baseUrl: `http://127.0.0.1:${fake.port}/v1`,
          api: "openai-completions",
          models: [
            {
              id: "spike-model",
              name: "Spike Model",
              contextWindow: 128000,
              maxTokens: 4096,
              input: ["text"],
            },
          ],
        },
      },
    },
    null,
    2,
  ),
);

const modelRuntime = await ModelRuntime.create({
  modelsPath,
  authPath,
  allowModelNetwork: false,
  refreshOnCreate: false,
});
await modelRuntime.setRuntimeApiKey("spike-fake", "spike-fake-key");

const model = modelRuntime.getModel("spike-fake", "spike-model");
check(
  "Q2a: models.json custom provider model resolvable",
  !!model,
  model ? `${model.providerId ?? "?"}/${model.id ?? "?"} api=${model.api ?? "?"}` : "getModel → undefined",
);
if (!model) {
  console.log(
    "providers:",
    modelRuntime.getProviders().map((p) => p.id),
  );
  process.exit(1);
}

// --- Custom tool (TypeBox schema, defineTool) ---
let toolExecuted = 0;
const spikeEcho = defineTool({
  name: "spike_echo",
  label: "Spike Echo",
  description: "Echoes a message back. Use for spike verification.",
  parameters: Type.Object({
    message: Type.String({ description: "Message to echo" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    toolExecuted++;
    return {
      content: [{ type: "text", text: `ECHO:${params.message}` }],
      details: { echoed: true },
    };
  },
});

// --- Run one session variant ---
async function runSessionVariant(noToolsValue) {
  const loader = new DefaultResourceLoader({
    cwd: runtimeDir,
    agentDir: runtimeDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: CUSTOM_SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    modelRuntime,
    model,
    noTools: noToolsValue,
    customTools: [spikeEcho],
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
  });

  const activeTools = session.getActiveToolNames();
  const eventCounts = {};
  session.subscribe((e) => {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  });

  await session.prompt("Please call the spike_echo tool now.");
  // Safety: wait until the session is fully idle (prompt may resolve before post-run settles)
  const deadline = Date.now() + 30_000;
  while (!session.isIdle && Date.now() < deadline) await sleep(100);

  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
  const finalText = (lastAssistant?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
  if (process.env.SPIKE_DEBUG) {
    console.error("[debug] messages:", JSON.stringify(session.messages.map((m) => ({ type: m.type, content: m.content })), null, 2).slice(0, 3000));
  }
  const sessionId = session.sessionId;
  session.dispose();
  return { activeTools, eventCounts, finalText, sessionId };
}

// --- Variant B (RECOMMENDED for KannaPi): noTools "builtin" ---
// Disables builtin coding tools (read/bash/edit/write) but keeps custom tools enabled.
const requestCountBeforeB = fake.requests.length;
const variantB = await runSessionVariant("builtin");
const serverTurnsB = fake.requests.slice(requestCountBeforeB);
check(
  'Q1b: noTools:"builtin" — builtin tools disabled, custom tools active',
  variantB.activeTools.length === 1 && variantB.activeTools[0] === "spike_echo",
  `activeTools=${JSON.stringify(variantB.activeTools)}`,
);
check(
  'Q1b: noTools:"builtin" — only spike_echo reaches the LLM',
  serverTurnsB.length > 0 && serverTurnsB.every((r) => JSON.stringify(r.toolNames) === '["spike_echo"]'),
  `server toolNames per turn: ${serverTurnsB.map((r) => JSON.stringify(r.toolNames)).join(" | ") || "<no requests reached server>"}`,
);

// --- Variant A (documented rejection): noTools "all" ---
// Empirically: "all" disables EVERYTHING including customTools. We record this as
// expected behavior (finding: KannaPi must use "builtin", never "all").
const requestCountBeforeA = fake.requests.length;
const variantA = await runSessionVariant("all");
const serverTurnsA = fake.requests.slice(requestCountBeforeA);
check(
  'Q1a: noTools:"all" disables customTools too (documented finding — KannaPi must use "builtin")',
  variantA.activeTools.length === 0 && serverTurnsA.every((r) => r.toolNames.length === 0),
  `activeTools=${JSON.stringify(variantA.activeTools)} serverToolNames=${serverTurnsA.map((r) => JSON.stringify(r.toolNames)).join(" | ")}`,
);

// --- Q3: custom system prompt reached the LLM (across both variants) ---
const allTurns = [...serverTurnsB, ...serverTurnsA];
check(
  "Q3: systemPrompt override reaches the LLM",
  allTurns.length > 0 && allTurns.every((r) => typeof r.systemPrompt === "string" && r.systemPrompt.includes("SPIKE_MARKER_KANNA")),
  allTurns[0]?.systemPrompt ? `system prompt starts: ${allTurns[0].systemPrompt.slice(0, 60)}...` : "no system message seen",
);

// --- Q4: tool executed + result fed back into the model's final answer (variant B) ---
check("Q4a: custom tool executed (variant B)", toolExecuted === 1, `toolExecuted=${toolExecuted}`);
check(
  "Q4b: tool result fed back — final answer embeds ECHO:hello-from-model",
  variantB.finalText.includes("SPIKE_OK: ECHO:hello-from-model"),
  `finalText=${JSON.stringify(variantB.finalText.slice(0, 120))}`,
);

// --- Q5: event stream observed headless (variant B) ---
const requiredEvents = ["agent_start", "turn_start", "message_update", "tool_execution_start", "tool_execution_end", "turn_end", "agent_end"];
const missing = requiredEvents.filter((t) => !(variantB.eventCounts[t] > 0));
check("Q5: headless event stream has all key event types", missing.length === 0, `missing=${JSON.stringify(missing)} counts=${JSON.stringify(variantB.eventCounts)}`);

// --- Session id sanity (Pi session machinery alive) ---
check("Q6: session has an id (session machinery active)", typeof variantB.sessionId === "string" && variantB.sessionId.length > 0, `sessionId=${variantB.sessionId}`);

fake.server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== SPIKE RESULT: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length > 0) {
  console.log("FAILED:", failed.map((f) => f.name).join("; "));
  process.exitCode = 1;
}
