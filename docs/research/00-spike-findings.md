# T0 Spike 结论：Pi coding-agent SDK 嵌入验证

> 日期：2026-09-07 · `@earendil-works/pi-coding-agent@0.85.1` · Node v24.14.0 · Windows
> 验证方式：spike/ 目录（fake OpenAI SSE 服务器 + models.json 自定义 provider + 无头 session），**9/9 断言通过**，无需真实 API key。

## 结论速览（KannaPi 集成配方）

```typescript
import {
  createAgentSession, defineTool, DefaultResourceLoader, ModelRuntime, SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 1. 模型：OpenAI 兼容端点经 models.json（注意顶层 providers 包装！）
const modelRuntime = await ModelRuntime.create({
  modelsPath, authPath, allowModelNetwork: false, refreshOnCreate: false,
});
await modelRuntime.setRuntimeApiKey(providerId, apiKey);
const model = modelRuntime.getModel(providerId, modelId);

// 2. 完全受控的资源环境 + 自定义系统提示词
const loader = new DefaultResourceLoader({
  cwd, agentDir,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  noContextFiles: true,
  systemPrompt: OUR_SECURITY_AGENT_PROMPT,
});
await loader.reload();

// 3. 无头会话：禁内置工具、注册自定义工具
const { session } = await createAgentSession({
  modelRuntime, model,
  noTools: "builtin",          // ← 关键！不是 "all"
  customTools: [tool1, tool2],
  sessionManager: SessionManager.inMemory(),  // 或 SessionManager.create(dir)
  resourceLoader: loader,
});
session.subscribe((event) => { /* UI 事件桥 */ });
await session.prompt("...");
while (!session.isIdle) await sleep(100);   // prompt 返回后仍需等 isIdle
session.dispose();
```

## 逐项验证结果

| # | 问题 | 结果 |
|---|---|---|
| Q1a | `noTools:"all"` 行为 | **连 customTools 一起禁用**（activeTools=[]，LLM 收到 tools=[]）。模型仍可发起工具调用，得到 "Tool not found" 错误结果并继续循环。**KannaPi 禁用 "all"** |
| Q1b | `noTools:"builtin"` 行为 | ✅ 禁用 read/bash/edit/write，保留 customTools；服务器侧确认只有自定义工具名到达 LLM |
| Q2 | models.json 自定义 provider | ✅ 顶层必须 `{"providers": {"<id>": {...}}}`（无包装会被 schema 校验拒绝且静默返回空 Map）；`api: "openai-completions"` 走 OpenAI SDK 客户端（baseUrl + /chat/completions）；`setRuntimeApiKey(id, key)` 提供凭据 |
| Q3 | 系统提示词控制 | ✅ `DefaultResourceLoader({systemPrompt})` 覆盖默认 coding-agent 提示词，服务器侧确认到达 LLM |
| Q4 | 自定义工具执行回环 | ✅ TypeBox schema + `defineTool` → 模型 tool_call → execute → 结果作为 toolResult 回传 → 模型最终回答引用工具输出 |
| Q5 | 无头事件流 | ✅ agent_start / turn_start / message_start/update/end / tool_execution_start/end / turn_end / agent_end / agent_settled 全部可订阅 |
| Q6 | 会话机制 | ✅ session.sessionId（UUIDv7）；SessionManager.inMemory()/create() |

## 重要 API 细节（踩坑记录）

1. **消息判别字段是 `role`**（`"user" | "assistant" | "toolResult"`），不是 `type`；assistant 内容块：`{type:"text"|"toolCall"|...}`（**toolCall 驼峰**，字段为 `id/name/arguments`）。
2. **`session.prompt()` 返回 ≠ 会话空闲**：需要轮询 `session.isIdle`（prompt 解析后 post-run 处理可能仍在进行）。
3. **models.json 静默失败**：schema 不合法时 `ModelRuntime.create` 不抛错，只是 provider 列表为空——务必检查 `getModel()` 返回值。
4. **authPath/modelsPath 可完全自定义**（spike 用临时目录，不触碰 `~/.pi/agent/`），`setRuntimeApiKey` 会写入指定 authPath。
5. **Windows 退出崩溃**：进程残留句柄时 `process.exit()` 触发 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`（src\win\async.c）——避免显式 process.exit，正常结束即可；`session.dispose()` + `server.close()` 后自然退出 EXIT=0。
6. `DefaultResourceLoader` 构造是异步 reload 模式：`new DefaultResourceLoader(opts)` 后必须 `await loader.reload()`。
7. 伪造 SSE 服务器即可驱动完整 agent 循环（tool_calls delta 累积格式标准 OpenAI）——**这条路线可作为 packages/agent 的确定性集成测试方案**，无需真实 LLM。

## 对 T10（packages/agent 防腐门面）的直接输入

- 门面参数：`{agentDir(独立数据目录), modelSpec:{providerId, modelId, apiKeyEnv}, systemPromptPath, tools[]}`。
- `noTools: "builtin"` 硬编码；`noExtensions/noSkills/noContextFiles` 全开。
- fake-openai-server 模式沉淀为 `packages/agent` 的测试工具（`tests/` 下复用 spike/fake-server.mjs 思路）。
- SDK 锁定 `0.85.1`（package.json 精确版本，无 `^`）。
