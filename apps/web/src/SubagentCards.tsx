import type { SubagentActivity } from "@kanna/shared";
import { MarkdownBody } from "./MarkdownBody.js";
import "./subagent-cards.css";

export function SubagentCards({ items }: { items: SubagentActivity[] }) {
  return <div className="subagent-cards" aria-label="Delegated agents">
    {items.map((item) => <details className={`subagent-card ${item.status}`} key={item.id}>
      <summary><span className="subagent-card-mark" aria-hidden="true">{item.agent === "scout" ? "⌕" : item.agent === "planner" ? "▤" : item.agent === "reviewer" ? "✓" : "⌘"}</span><span className="subagent-card-title"><b>{item.agent}</b><small>{item.lastTool ? `${item.lastTool} · ` : ""}{item.toolCount} tool calls</small></span><span className="subagent-card-status">{item.status}</span></summary>
      <div className="subagent-card-body"><p className="subagent-task">{item.task}</p><small>{item.model} · {item.toolProfile} tools</small>
        {item.error && <p className="subagent-error" role="status">{item.error}</p>}
        {item.text ? <div className="subagent-answer"><MarkdownBody>{item.text}</MarkdownBody></div> : <p className="subagent-empty">{item.status === "queued" ? "Waiting for a slot or the previous chain step." : item.status === "running" ? "Working on this task…" : "No text output recorded."}</p>}
        {!!item.transcript.length && <details className="subagent-transcript"><summary>Recent execution ({item.transcript.length} records)</summary>{item.transcript.map((entry, index) => <div key={index}><b>{entry.toolName ?? item.agent}{entry.isError ? " · failed" : ""}</b><pre>{entry.text}</pre></div>)}</details>}
      </div>
    </details>)}
  </div>;
}
