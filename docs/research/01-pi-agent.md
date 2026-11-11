# 研究报告 1：Pi Agent 框架深度分析

> 调研日期：2026-09-07 · 全部结论经 GitHub 源码 / npm registry / pi.dev 文档验证，未验证项已标注。

## 0. 关键发现：项目已迁移

- `github.com/badlogic/pi-mono` **重定向**至 `github.com/earendil-works/pi`（仓库转移）。
- Pi 现由 Earendil Inc. 维护（Mario Zechner / badlogic、Armin Ronacher / mitsuhiko、rwachtler）。
- npm 旧包 `@mariozechner/pi-agent-core`、`@mariozechner/pi-coding-agent` **已废弃**（停在 0.73.1，弃用提示指向新包）。
- 现行包：**`@earendil-works/*` v0.85.1**（本报告基准版本）。
- 文档站：https://pi.dev/docs/latest（源：仓库 `packages/coding-agent/docs/*.md`）。
- ⚠️ 任何引用 `@mariozechner/*`、`pi-mono`、"4 packages" 的教程均已过时。

## 1. Monorepo 包结构（11 个包）

| 目录 | npm 包名（均 0.85.1） | 用途 |
|---|---|---|
| `packages/agent` | `@earendil-works/pi-agent-core` | 通用 Agent：agent loop、Agent 类、工具类型、JSONL 会话、compaction、skills、内置 read/write/edit/bash 工具、AgentHarness |
| `packages/ai` | `@earendil-works/pi-ai` | 统一多提供商 LLM API：模型注册表、鉴权解析、token/成本追踪、TypeBox 工具 Schema、流式 |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | `pi` CLI + **可嵌入 SDK**（本项目使用的包） |
| `packages/tui` | `@earendil-works/pi-tui` | 终端 UI（差分渲染） |
| `packages/chord` | `@earendil-works/chord` | 应用组合运行时（服务/复制状态/RPC/插件） |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | 厂商中立遥测契约 |
| `packages/protocol` | `@earendil-works/pi-protocol` | 实验性：路由信封、CBOR（**无兼容性保证**） |
| `packages/server` | `@earendil-works/pi-server` | 实验性：Unix socket 本地服务（无 HTTP/WS） |
| `packages/client` | `pi-client` | 上述服务的客户端 |
| `packages/evals` | — | 评测 harness |
| `packages/session-backends/sqlite-node` | — | SQLite 会话后端 |

**运行时事实**：ESM-only（`"type":"module"`）、TypeScript、Node **≥22.19.0**（本机 24.14 ✓）、构建 tsgo、测试 Vitest、lint Biome、仓库用 npm workspaces（注意：counterposition/pi 用 pnpm，勿混淆）。

## 2. Agent Core 关键 API（`packages/agent/src/types.ts` 等）

### 2.1 工具接口

```typescript
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal,
            onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
  replay?: "never" | "safe";
  executionMode?: ToolExecutionMode; // "sequential" | "parallel"
}
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // 发给 LLM
  details: T;                               // UI 渲染 / 状态重建
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

- **Schema 格式：TypeBox**（`Type.Object({...})`），**不是 zod**；枚举必须用 `@earendil-works/pi-ai` 的 **`StringEnum`**（`Type.Union`/`Type.Literal` 在 Google API 上会坏）。
- 参数在 `execute` 前经 TypeBox/AJV 自动校验。
- **错误处理：在 execute 内 throw** → 结果标记 `isError:true` 报告给 LLM；返回对象永远不是错误。
- 进度流：`onUpdate?.({content:[...]})`；取消：`signal?.aborted`。

### 2.2 Agent Loop

```typescript
function agentLoop(prompts, context, config, signal, streamFn): EventStream<AgentEvent, AgentMessage[]>;
```

`AgentLoopConfig` 关键字段：`model`、`convertToLlm`、`transformContext`、`shouldStopAfterTurn`、`prepareNextTurn`、`getSteeringMessages`、`getFollowUpMessages`、`toolExecution`（默认 parallel）、**`beforeToolCall`**（可返回 `{block, reason, terminate}` —— agent-core 层权限门）、`afterToolCall`（可改写 content/details）。

循环算法（源码验证）：seed prompts → 外层 followUp 循环 → steering 消息入列 → `streamAssistantResponse`（transformContext → convertToLlm → 取 API key → 流式，部分消息边流边发事件）→ stopReason 为 error/aborted 则停；为 `length` 则**该消息所有工具调用全部记为错误**；否则顺序/并行执行工具（lookup → prepareArguments → validate → beforeToolCall → execute → afterToolCall）。**无 max-iteration 参数**（设计使然）。

`Agent` 类（有状态包装）：`subscribe/unsubscribe`、`state`、`steer/followUp`（"all"|"one-at-a-time"）、`abort()`、`waitForIdle()`、`prompt()`、`continue()`。

### 2.3 事件流（UI 消费）

```typescript
type AgentEvent =
  | { type: "agent_start" } | { type: "agent_end"; messages }
  | { type: "turn_start" } | { type: "turn_end"; message; toolResults }
  | { type: "message_start" | "message_end"; message }
  | { type: "message_update"; message; assistantMessageEvent }   // text_delta 等增量
  | { type: "tool_execution_start" | "tool_execution_update"; toolCallId; toolName; args; ... }
  | { type: "tool_execution_end"; toolCallId; toolName; result; isError };
```

### 2.4 LLM 提供商（pi-ai）

~30+ 提供商，底层仅 4 种 wire API（openai-completions / openai-responses / anthropic-messages / google-generative-ai）。**任意 OpenAI 兼容端点**（Ollama/vLLM/LM Studio/网关）经 `~/.pi/agent/models.json` 自定义：`{baseUrl, api, apiKey(支持 "!shell-cmd" 与 "$ENV" 解析), models, modelOverrides}`。`Context = {systemPrompt, messages, tools}` 为纯 JSON → 支持会话中途跨提供商换模型。

### 2.5 会话与 compaction

- 会话持久化已并入 agent-core：`JsonlSessionRepo`、`MemorySessionRepo`、`StorageBackedSession`、`AgentHarness.create()`（多 lane 分支执行、11 个 hook、`watch()` 快照供远程消费者）。
- Compaction：`contextTokens > contextWindow - reserveTokens`（默认 reserve 16384 / keepRecent 20000）触发，回溯合法切点，LLM 结构化摘要后重建上下文。
- Coding-agent 会话格式：`~/.pi/agent/sessions/<cwd-dir>/<ts>_<uuid>.jsonl`；每 entry 有 8 位 hex `id`+`parentId` → 树形分支；entry 类型含 message / compaction / branch_summary / custom（扩展状态，不入 LLM）等。

## 3. Coding Agent 与 SDK 嵌入（本项目的集成路径）

- 内置工具：read/write/edit/bash/powershell/grep/find/ls（grep/find/ls 默认禁用）；SDK 导出工厂 `createCodingTools`、`createBashTool` 等。
- **无内置 subagent**（官方反模式声明）；官方示例用子进程实现（`examples/extensions/subagent/`，agent 定义为带 YAML frontmatter 的 markdown，单/并行(≤8 任务,4 并发)/链式，输出 50KB/任务上限）。认可的替代：递归 `createAgentSession()`（SDK 可重入）。
- 四种运行模式：TUI / print-JSON / RPC(`pi --mode rpc`，自定义 JSONL 而非 JSON-RPC) / **SDK 进程内**。
- **SDK 最小示例**（`examples/sdk/01-minimal.ts`，逐字验证）：

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory(), modelRuntime });
session.subscribe((event) => { /* ... */ });
await session.prompt("...");
session.dispose();
```

- `CreateAgentSessionOptions`：`cwd`、`agentDir`、`modelRuntime`、`model`、`thinkingLevel`、`scopedModels`、**`noTools`**、`tools`（白名单）、`excludeTools`、**`customTools`**、`resourceLoader`、`sessionManager`、`settingsManager`。
- 13 个 SDK 示例；`12-full-control.ts` 演示"替换一切、无资源发现"。
- `defineTool` 从 SDK 导出，配合 `customTools` 使用（确切泛型签名未提取——`types.ts` 过大；用法经官方文档示例验证）。

## 4. Extensions 与 Skills

- 扩展：TypeScript 模块经 jiti 加载（无构建步骤）；全局 `~/.pi/agent/extensions/*.ts`、项目 `.pi/extensions/*.ts`（需项目信任）、`pi -e ./path.ts`。默认导出工厂接收 `ExtensionAPI`：`pi.on(event, handler)`（**`tool_call` 事件可返回 `{block:true, reason}` —— 权限门**）、`pi.registerTool/registerCommand/registerShortcut/registerFlag/registerProvider`、`pi.sendMessage/sendUserMessage`、`pi.appendEntry`（持久化非 LLM 状态）。
- 事件生命周期：project_trust → session_start → resources_discover → input → before_agent_start → agent_start → turn_start → context → tool_call → tool_result → turn_end → agent_end → agent_settled（+ session_* 事件）。
- 67 个官方扩展示例，含 `permission-gate.ts`、`confirm-destructive.ts`、`sandbox/`、`gondolin/`（微型 VM）、`subagent/`。
- Skills：实现 agentskills.io 标准；SKILL.md（YAML frontmatter：name ≤64 字符小写连字符、description ≤1024 字符）+ 渐进披露（系统提示只放 name+description，正文按需 read 加载）；发现路径 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`（信任门控）等。
- Pi 包分发：`package.json` 带 `pi` manifest 键（extensions/skills/prompts/themes 路径数组）；`pi install npm:...|git:...|<path>`。

## 5. 安全模型（重要）

- **Pi 无内置权限系统/沙箱**："以启动用户权限运行"；文档明确拒绝进程内伪沙箱（易被误解为安全边界）。
- 现有机制：项目信任门控（`~/.pi/agent/trust.json`）；`tool_call` 扩展事件 `{block,reason}`；agent-core `beforeToolCall`；容器化文档（Docker/Gondolin/OpenShell）。
- **结论：本项目的 PolicyEngine/ApprovalManager 必须完全自建**（ADR-004）。

## 6. 嵌入结论（本项目采用）

**在 Node 后端嵌入 `@earendil-works/pi-coding-agent` 的 `createAgentSession()`，工具经 `customTools` 注册，UI 事件经 `session.subscribe()` 桥接**。理由：会话树/compaction/steering/模型管理/事件流全部免费；文档化路径+13 示例。Pi 无 HTTP/WS 服务（pi-server 仅 Unix socket）→ WebSocket 桥由我们自建。LLM 凭据如需服务端集中持有可用 `streamProxy`（agent-core `proxy.ts`，LLM 调用中介，非网络代理）。

## 7. 坑清单（Gotchas）

1. 命名迁移是头号陷阱（旧教程全过时）。
2. pre-1.0 快速演进（0.73→0.85 数月）；protocol/server 无兼容保证 → **锁版本+防腐门面**。
3. Node ≥22.19、ESM-only。
4. TypeBox 非 zod；枚举用 StringEnum。
5. 工具输出强制 50KB/2000 行截断 → 分页设计。
6. stopReason=length 时整批工具调用记错 → 工具参数要短。
7. RPC 非标准 JSON-RPC；Node readline 对 U+2028/2029 不合规。
8. 许可：Pi monorepo = **MIT**（论文可用）；counterposition/pi = **GPL-3.0**（复制其扩展代码有传染风险，只借鉴模式）。
9. `~/.pi/agent/` 存凭据，勿入容器。
10. 新贡献者 PR 默认自动关闭——不要依赖上游合入变更。

## 8. 关键 URL

- 仓库：https://github.com/earendil-works/pi
- 文档：https://pi.dev/docs/latest（`/sdk` `/rpc` `/json` `/extensions` `/skills` `/packages` `/session-format` `/compaction` `/security` `/containerization` `/models` `/custom-provider`）
- SDK 示例：`packages/coding-agent/examples/sdk/`（01–13）、`examples/extensions/`（67 个）
- npm：registry.npmjs.org/@earendil-works/pi-coding-agent
- 博客：mariozechner.at/posts/2025-11-30-pi-coding-agent/ · /2025-11-02-what-if-you-dont-need-mcp/
