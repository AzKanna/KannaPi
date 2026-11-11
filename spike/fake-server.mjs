// T0 Spike — Fake OpenAI-compatible SSE server.
// Emulates a 2-turn scripted conversation:
//   turn 1: assistant issues a tool_call for `spike_echo`
//   turn 2 (after tool result arrives): assistant returns final text "SPIKE_OK: <tool content>"
// Records every request so the spike can assert what actually reached the "LLM".
import { createServer } from "node:http";

export function startFakeOpenAIServer() {
  /** @type {Array<{toolNames: string[], systemPrompt: string | null, hasToolResult: boolean, lastToolContent: string | null, messageRoles: string[]}>} */
  const requests = [];

  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.includes("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${req.url}` } }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const messages = parsed.messages ?? [];
      const hasToolResult = messages.some((m) => m.role === "tool");
      const lastTool = [...messages].reverse().find((m) => m.role === "tool");
      requests.push({
        toolNames: (parsed.tools ?? []).map((t) => t.function?.name ?? t.name ?? "?"),
        systemPrompt: messages.find((m) => m.role === "system")?.content ?? null,
        hasToolResult,
        lastToolContent: typeof lastTool?.content === "string" ? lastTool.content : null,
        messageRoles: messages.map((m) => m.role),
      });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const id = "chatcmpl-spike";
      const created = Math.floor(Date.now() / 1000);
      const model = "spike-model";
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish_reason = null) =>
        send({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] });

      if (!hasToolResult) {
        chunk({ role: "assistant", content: "" });
        chunk({ tool_calls: [{ index: 0, id: "call_spike_1", type: "function", function: { name: "spike_echo", arguments: "" } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ message: "hello-from-model" }) } }] });
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: "" });
        chunk({ content: `SPIKE_OK: ${lastTool?.content ?? "<none>"}` });
        chunk({}, "stop");
      }
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, requests }),
    );
  });
}
