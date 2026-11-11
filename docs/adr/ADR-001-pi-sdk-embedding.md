# ADR-001：Agent 运行时 = Pi coding-agent SDK 进程内嵌入

状态：已接受（2026-09-07）· 经 T0 spike 实证（docs/research/00-spike-findings.md）

## 决策
后端 `apps/server` 经 `packages/agent`（唯一 SDK 接触点，防腐门面）import `@earendil-works/pi-coding-agent@0.85.1`（精确锁定），用 `createAgentSession({ modelRuntime, model, noTools:"builtin", customTools, sessionManager, resourceLoader })` 组装 Agent。全部浏览器/流量/安全工具经 `customTools: ToolDefinition[]`（TypeBox schema + `defineTool`）注册；系统提示词经 `DefaultResourceLoader({systemPrompt, noExtensions:true, noSkills:true, noContextFiles:true})` 完全接管。UI 事件经 `session.subscribe()` → WebSocket 总线。

## 理由
- 复用最大化：JSONL 会话树（分支/恢复）、compaction、steering/followUp 队列、模型管理、token 级事件流全部免费，均经 T0 验证可用。
- 官方文档化路径（13 个 SDK 示例；`12-full-control` 模式即"替换一切"）。

## 被否方案
1. **agent-core 裸建**：需重造 session/compaction/模型管理——违背"优先复用 Pi runtime"总原则。
2. **`pi --mode rpc` 子进程**：自定义工具须绕道 extension 机制注入；自定义 JSONL 协议桥接成本高。
3. **fork coding-agent**：上游 pre-1.0 高频演进，fork 维护负担不可承受。
4. **写成 Pi extension**：那是给 stock `pi` CLI 用户的分发形态；本项目是独立服务端应用。

## 实证要点（T0）
- `noTools` 取值 `"all" | "builtin"`（非 boolean）；**`"all"` 连 customTools 一起禁用** → 必须用 `"builtin"`。
- models.json 顶层必须 `{"providers": {...}}` 包装；schema 不合法时**静默失败**（provider 列表为空）→ 门面必须检查 `getModel()` 返回值。
- 消息判别字段 `role`；assistant 内容块 `toolCall`（驼峰）。
- `prompt()` 返回 ≠ 空闲，需轮询 `session.isIdle`。

## 后果
+ 会话/压缩/事件流零成本；SDK 升级隔离在 packages/agent 单包内。
− Pi pre-1.0 演进风险由锁版本承担；SDK API 变化时只改门面。
