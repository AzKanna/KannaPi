# ADR-010：许可与学术诚信

状态：已接受（2026-09-07）

## 决策
**可自由使用**（MIT/Apache）：Pi monorepo(MIT)、OWASP Juice Shop(MIT)、Playwright(Apache-2.0)、React(MIT)、typebox(MIT)、uuidv7(MIT)。

**只借鉴架构思想、零代码复制**：
- burpwn — AGPL-3.0-only（且 Rust/Linux-only 本就不可直接用）
- counterposition/pi — GPL-3.0（复制其扩展代码有传染风险）
- CAI — 已归档，MIT+专有双许可但不可维护
- HexStrike-AI、pi-skill-pentesting、BurpAI、burp-ai-agent — 只读研究，不抄代码
- WSTG 检查逻辑、OWASP 清单 — 自行编写

**AGPL 处理**：mitmproxy 以独立子进程 CLI 方式调用；自有 addon（flow_sink.py）运行于其进程内但仅作数据搬运；论文与源码一并公开即满足 AGPL 精神；接口隔离于 services/proxy，必要时可换引擎。

**学术诚信**：参考项目均在 docs/research/ 与论文中显式引用；评测使用 Juice Shop 自带的挑战自动验证作为 ground truth，不伪造结果；重复实验报告方差（arXiv:2605.30096）。

## 后果
+ 毕设可公开源码、可辩护。
− 无从 AGPL/GPL 项目粘贴代码的捷径——所有实现自写（本来也是毕设要求）。
