# ADR-006：工具 Schema = TypeBox + StringEnum + 分页 + 脱敏

状态：已接受（2026-09-07）

## 决策
- 工具 schema 一律 **TypeBox**（`Type.Object`），枚举一律 **`StringEnum`**（`Type.Union/Type.Literal` 在 Google API 上会坏——Pi 生态约束）。
- 错误处理：execute 内 **throw**（Pi 约定：throw 即 isError 报告给 LLM）。
- 进度：`onUpdate?.({content:[...]})`；取消：尊重 `signal.aborted`（长扫描必须可取消）。
- **输出预算**：列表 ≤100 行；正文 ≤8KB/次；`nextOffset` 分页（pi-web-search 模式）——Pi 硬截断 50KB/2000 行，超过即内容丢失。
- **脱敏**：入 LLM 上下文的流量/正文默认经 SecretRedactor；原始字节完整存 SQLite（证据完整性）。privacy 配置 off/balanced/strict。
- 工具数量纪律：Phase 1 注册 15 个；每工具 schema ~120-150 token/轮（CAI 实测二次方累积）——后续阶段按需增量并合并同类（如 browser_get_page 合并 dom/text/forms/links）。

## 理由
Pi 的 TypeBox/AJV 参数校验在 execute 前自动执行；分页+列表/详情分离是 agent 在数千 flow 上可用的唯一方式（burp-ai-agent 的 LimitedStringBuilder 与字节预算同思路）。

## 后果
+ token 成本可控；超长内容可控降级而非静默截断。
− 工具作者必须遵守分页与预算约定——由 packages/agent 的工具工厂统一提供 `paginated()`/`boundedText()` 辅助函数。
