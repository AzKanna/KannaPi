# ADR-008：单 Agent 起步，subagent 延后；Reporter 恒为零工具

状态：已接受（2026-09-07）

## 决策
Phase 1-6 单 MainAgent + 15-25 个工具（观察→思考→计划→行动→更新状态 循环）。阶段稳定后再拆分：
- Recon / TrafficAnalyst / Security / Verifier → **递归 `createAgentSession()`**（SDK 可重入，Pi 官方认可的委派方式）；
- **Reporter 恒为零工具 agent**（CAI 模式：报告综合器不带任何执行工具，隔离渗透会话历史中残留指令的污染）。

## 理由
- 用户原则 12"不要为了看起来 Agentic 而过度 Multi-Agent"。
- Pi 作者明确视进程内并行子代理为反模式（"opaque black boxes"）；认可的方式是子进程或递归 session。
- CAI 教训：编排器不该有通用侦察工具（会长思考循环自己解题而非委派）；worker 必须有轮次/输出预算。
- PentestEval：端到端管道 ~31% 成功率——先把单 agent 循环+状态模型做扎实，拆分才有意义。

## 后果
+ Phase 1-6 架构简单、调试成本低、token 成本可控。
− 单 agent 上下文压力大——由 Pi compaction + ApplicationState 快照（T8）+ 工具分页共同缓解。
