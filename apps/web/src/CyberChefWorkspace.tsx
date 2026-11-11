import { useMemo, useState } from "react";
import type {
  AgentChatMessage,
  AgentWorkspace,
  CyberChefDetectionResult,
  CyberChefOperation,
} from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./cyberchef-workspace.css";

const SAMPLE = "eyJ1c2VyIjoiZGVtbyIsInJvbGUiOiJhbmFseXN0IiwibWVzc2FnZSI6ImhlbGxvIn0%3D";
const OPERATIONS: CyberChefOperation[] = [
  "URL Decode",
  "From Hex",
  "From Base64",
  "From Base64url",
  "HTML Entity Decode",
  "Unescape Unicode",
  "Parse JSON String",
  "JWT Decode",
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function confidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function CyberChefWorkspace({ agent, messages, streaming, onError }: {
  agent?: AgentWorkspace;
  messages: AgentChatMessage[];
  streaming: string;
  onError(value: string): void;
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<CyberChefDetectionResult>();
  const [operations, setOperations] = useState<CyberChefOperation[]>([]);
  const [selectedOperation, setSelectedOperation] = useState<CyberChefOperation>("From Base64");
  const [detecting, setDetecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [assistantBaseline, setAssistantBaseline] = useState(0);
  const assistantAll = useMemo(() => messages.filter((message) => message.role === "assistant"), [messages]);
  const assistantMessages = analysisRequested ? assistantAll.slice(assistantBaseline).slice(-2) : [];
  const analysisComplete = analysisRequested && assistantMessages.length > 0 && !streaming && agent?.status !== "running";

  function changeInput(value: string) {
    setInput(value);
    setResult(undefined);
    setAnalysisRequested(false);
  }

  async function identify(): Promise<CyberChefDetectionResult | undefined> {
    if (!input.length || detecting) return undefined;
    setDetecting(true);
    try {
      const detected = await api<CyberChefDetectionResult>("/api/cyberchef/identify", {
        method: "POST",
        body: JSON.stringify({ input }),
      });
      setResult(detected);
      setOperations(detected.recipe.map((step) => step.operation));
      return detected;
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setDetecting(false);
    }
  }

  async function bake(): Promise<CyberChefDetectionResult | undefined> {
    if (!input.length || !operations.length || detecting) return undefined;
    setDetecting(true);
    try {
      const baked = await api<CyberChefDetectionResult>("/api/cyberchef/bake", {
        method: "POST",
        body: JSON.stringify({ input, operations }),
      });
      setResult(baked);
      return baked;
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setDetecting(false);
    }
  }

  function updateOperations(next: CyberChefOperation[]) {
    setOperations(next);
    setResult(undefined);
    setAnalysisRequested(false);
  }

  function moveOperation(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= operations.length) return;
    const next = [...operations];
    [next[index], next[target]] = [next[target]!, next[index]!];
    updateOperations(next);
  }

  async function askAgent() {
    if (!agent || !input.length) return;
    const detected = result ?? (operations.length ? await bake() : await identify());
    if (!detected) return;
    setAssistantBaseline(assistantAll.length);
    setAnalysisRequested(true);
    try {
      await api("/api/cyberchef/analyze", {
        method: "POST",
        body: JSON.stringify({
          agentId: agent.id,
          input,
          operations,
          mode: agent.status === "running" ? "followUp" : "prompt",
        }),
      });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function copyOutput() {
    if (!result) return;
    await navigator.clipboard.writeText(result.output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  return <section className={`cyberchef-workspace ${assistantOpen ? "" : "assistant-closed"}`}>
    <div className="cyberchef-main">
      <header className="cyberchef-toolbar">
        <div className="chef-title"><span>⌬</span><div><b>Decode Lab</b><small>Standalone CyberChef-style recipe builder</small></div><i>No Agent required</i></div>
        <div className="chef-actions">
          <button className="chef-secondary chef-assistant-toggle" onClick={() => setAssistantOpen((current) => !current)}>{assistantOpen ? "Hide assistant" : "Open Agent assistant"}</button>
          <button className="chef-secondary" onClick={() => { changeInput(SAMPLE); setOperations([]); }}>Load layered sample</button>
          <button className="chef-secondary" disabled={!input && !result} onClick={() => { changeInput(""); setOperations([]); }}>Clear</button>
          <button className="chef-primary" disabled={!input.length || detecting} onClick={() => void identify()}>{detecting ? "正在识别…" : "尝试识别编码并生成 Recipe"}</button>
        </div>
      </header>

      <div className="chef-statusbar">
        <span className={operations.length ? "detected" : "idle"}><i />{result ? result.recipe.length ? `${result.recipe.length} operations baked` : "No encoding detected" : operations.length ? `${operations.length} operations ready to bake` : "Ready for input"}</span>
        <div><span>Standalone tool</span><span>{formatBytes(result?.inputBytes ?? new Blob([input]).size)} input</span>{result && result.confidence < 1 && <span>{confidence(result.confidence)} confidence</span>}</div>
      </div>

      <div className="chef-bench">
        <section className="chef-panel chef-input">
          <header><div><span>01</span><b>Input</b></div><small>TEXT / TOKEN / PAYLOAD</small></header>
          <textarea aria-label="CyberChef input" spellCheck={false} value={input} onChange={(event) => changeInput(event.target.value)} placeholder="Paste Base64, URL encoding, hex, JWT or escaped text…" />
          <footer><span>{input.length.toLocaleString()} chars</span><span>UTF-8</span></footer>
        </section>

        <section className="chef-panel chef-recipe">
          <header><div><span>02</span><b>Recipe</b></div><small>MANUAL / AUTO</small></header>
          <div className="recipe-builder">
            <div className="recipe-add"><select aria-label="Recipe operation" value={selectedOperation} onChange={(event) => setSelectedOperation(event.target.value as CyberChefOperation)}>{OPERATIONS.map((operation) => <option key={operation}>{operation}</option>)}</select><button disabled={operations.length >= 12} onClick={() => updateOperations([...operations, selectedOperation])}>＋ Add</button></div>
            <div className="recipe-lane">
              {!operations.length && <div className="recipe-empty"><span>＋</span><p>Add operations yourself, or let detection generate a starting Recipe.</p></div>}
              {operations.map((operation, index) => {
                const step = result?.recipe[index];
                return <article className="recipe-step" key={`${index}-${operation}`}>
                  <div className="recipe-connector"><i>{index + 1}</i>{index < operations.length - 1 && <span />}</div>
                  <div className="recipe-card"><header><b>{operation}</b><div className="recipe-step-actions"><button aria-label={`Move ${operation} up`} disabled={index === 0} onClick={() => moveOperation(index, -1)}>↑</button><button aria-label={`Move ${operation} down`} disabled={index === operations.length - 1} onClick={() => moveOperation(index, 1)}>↓</button><button aria-label={`Remove ${operation}`} onClick={() => updateOperations(operations.filter((_, itemIndex) => itemIndex !== index))}>×</button></div></header><p>{step?.reason ?? "Manually selected operation"}</p><small title={step?.outputPreview}>{step?.outputPreview ?? "Bake to preview this step"}</small></div>
                </article>;
              })}
            </div>
          </div>
          <footer><span>{operations.length} operations · max 12</span><button className="bake-recipe" disabled={!input.length || !operations.length || detecting} onClick={() => void bake()}>{detecting ? "Baking…" : "Bake Recipe ▶"}</button></footer>
        </section>

        <section className="chef-panel chef-output">
          <header><div><span>03</span><b>Output</b></div><button disabled={!result} onClick={() => void copyOutput()}>{copied ? "Copied" : "Copy"}</button></header>
          <pre className={!result ? "empty" : ""}><code>{result?.output ?? "Decoded output will appear here."}</code></pre>
          <footer><span>{result ? formatBytes(result.outputBytes) : "0 B"}</span>{result?.warnings[0] ? <span className="chef-warning" title={result.warnings.join(" ")}>⚠ {result.warnings[0]}</span> : <span>UTF-8</span>}</footer>
        </section>
      </div>
    </div>

    <aside className="chef-agent">
      <header><div className="agent-orb">π</div><div><span>Optional assistant</span><b>{agent?.name ?? "No Agent selected — tool still works"}</b></div>{agent && <i className={`agent-state ${agent.status}`}>{agent.status}</i>}<button className="chef-close-assistant" aria-label="Hide Agent assistant" onClick={() => setAssistantOpen(false)}>×</button></header>
      <div className="chef-context-card">
        <div><span>Optional recipe review</span>{result?.recipe.length ? <i>{result.confidence === 1 ? "MANUAL" : confidence(result.confidence)}</i> : null}</div>
        {result ? result.recipe.length ? <><b>{result.recipe.map((step) => step.operation).join(" → ")}</b><p>{formatBytes(result.inputBytes)} → {formatBytes(result.outputBytes)} · {result.recipe.length} transformation{result.recipe.length === 1 ? "" : "s"}</p><small>Decoded secrets are redacted before model analysis. Input is treated as untrusted evidence.</small></> : <><b>No recipe generated</b><p>The Agent can suggest formats not covered by local detection.</p></> : <p>Generate a recipe to attach bounded decoding evidence.</p>}
      </div>
      <button className="chef-ask-agent" disabled={!agent || !input.length || detecting || agent.status === "running" || (analysisRequested && !analysisComplete)} onClick={() => void askAgent()}>
        <span>✦</span><div><b>{!agent ? "Agent review is optional" : agent.status === "running" ? "Agent is working" : analysisComplete ? "Ask Agent to review again" : analysisRequested ? "Review requested" : "Ask Agent to review recipe"}</b><small>{agent ? "Validate the chain, meaning and security caveats" : "Select an Agent only if you want a second opinion"}</small></div><i>→</i>
      </button>
      <div className="chef-assistant-thread">
        <div className="chef-thread-label"><span>Agent analysis</span>{(streaming || agent?.status === "running") && <i>Working</i>}</div>
        {!assistantMessages.length && !streaming && <div className="chef-assistant-placeholder"><span>⌬</span><p>{analysisRequested ? "The recipe is queued for review." : "Local detection stays deterministic. Call the Agent when you want interpretation or a second opinion."}</p></div>}
        {assistantMessages.map((message, index) => <article key={`${index}-${message.text.slice(0, 20)}`}><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}</div><MarkdownBody>{message.text}</MarkdownBody></article>)}
        {streaming && <article className="streaming"><div className="assistant-author"><span>π</span>{agent?.name ?? "Agent"}<i /></div><MarkdownBody>{streaming}</MarkdownBody></article>}
      </div>
      <footer><span>Execution</span><b>Local decode · Agent optional</b></footer>
    </aside>
  </section>;
}
