# Agent Chat 多 Agent 协作

在普通 **Agent Chat** 中使用 Pi 的 `subagent` 工具，可以将任务委派给独立的子 Agent。采用 dg-piagent H06 的同进程多 Session 模式；每个子 Agent 单独创建 Pi Session，独立维护消息、工具循环和上下文压缩，完成后释放 Session。

## 使用入口

在 **Settings → Execution & Context → Multi-Agent delegation** 设置开关、并发上限和单任务超时，然后保存。默认开启，最多同时执行 4 个子任务，单任务默认 10 分钟；批次最多 8 个任务。

选择具有工具权限的 Agent，在普通对话中直接提出协作要求，例如：

- “并行调用两个 Scout，分别检查前端和 API，然后汇总发现。”
- “让 Scout 检查项目，再让 Planner 根据检查结果制定计划，最后让 Worker 实现。”
- “先让 Worker 完成这个修改，再让 Reviewer 独立检查结果。”

主 Agent 根据任务决定是否调用 `subagent`，用户也可以明确要求委派。工具权限为 `chat` 的纯对话 Agent 不注册该工具。

## 内置子 Agent

| 子 Agent | 职责 | 工具权限 |
| --- | --- | --- |
| Scout | 快速检查资料、收集事实与文件引用 | 只读 |
| Planner | 基于事实生成执行计划和验证条件 | 只读 |
| Reviewer | 独立审查结果，指出证据支持的问题 | 只读 |
| Worker | 实现明确的任务并报告验证结果 | 不超过主 Agent 的权限 |

子 Agent 继承当前选定模型、思考强度、工作区、Skills 和压缩配置，不继承主对话历史；主 Agent 必须在委派说明中提供必要背景。当前使用这四种内置角色，不会读取或安装用户目录中的 Pi CLI Subagent 扩展。

## 三种调用形式

一次调用只能使用一种模式。

单任务：

```json
{"agent":"scout","task":"检查项目入口，列出相关文件与证据。"}
```

并行：

```json
{"tasks":[
  {"agent":"scout","task":"检查前端，记录可确认的问题。"},
  {"agent":"scout","task":"检查 API，记录可确认的问题。"}
]}
```

链式：

```json
{"chain":[
  {"agent":"scout","task":"检查当前项目并收集相关事实。"},
  {"agent":"planner","task":"根据这些事实给出实施计划：\n{previous}"},
  {"agent":"worker","task":"实施这个计划并验证：\n{previous}"}
]}
```

并行模式中的单个失败不影响其他子任务；链式模式将上一阶段的可见文本替换到 `{previous}`，某阶段失败后跳过后续阶段。执行结果交回主 Agent，由它继续解释和汇总。

## 过程与记录

聊天中的工具调用区显示 **Multi-Agent delegation** 卡片，包含各子 Agent 的排队、运行、完成、失败、停止状态。展开卡片可以查看任务、模型、可见回复、工具调用次数和近期执行记录。不会展示隐藏的思维内容。

子 Session 使用内存历史，避免创建大量普通聊天会话。汇总文本、各子 Agent 的结果和有长度限制的近期记录写入主 Session 的 Pi JSONL 工具结果；重新打开同一 Session 可以恢复卡片。单任务结果最多保留 50,000 字符，最近最多 16 条记录、每条最多 2,000 字符；传回主模型的合计文本最多 50,000 字符。超出部分会明确标记截断。

## 工作区与停止

沙箱开启时，子 Agent 的本地工具复用当前 Session 的 AppContainer 工作副本，保持原有隔离与联网设置；子 Agent 结束不会释放主 Session 的沙箱。沙箱关闭时，在选定的真实工作区执行允许的内置工具。多个 Worker 应分配不同文件，避免同时修改同一文件。

子 Agent 不注册递归委派、MCP、SSH 或 Pi Plugin 工具；内置工具按照角色和主 Agent 的权限上限选择，`web_search` 继续使用现有只读代理。点击主对话 **Stop** 会取消正在执行的子 Agent，队列中尚未执行的任务不会启动；超时会中止该子任务。模型调用、重试和压缩均使用现有模型配置，多个子 Agent 会产生额外 API 用量。

## 验证

```powershell
pnpm build
pnpm exec vitest run packages/agent/src/subagent-tool.test.ts apps/server/src/subagent-agent.test.ts apps/server/src/runtime-features.test.ts apps/web/src/state.test.ts
```

测试使用本地模拟模型，覆盖并发限额、失败隔离、链式传递、中止与超时、独立上下文、禁止递归、沙箱文件写入、可见进度、结果恢复，以及运行设置兼容旧版本。
