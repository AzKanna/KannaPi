# ADR-007：安全推理 = 观察 → 假设 → 证据 → 最小验证 → 结论

状态：已接受（2026-09-07）

## 决策
- **Passive 分析器 = 确定性纯函数** `(TrafficFlow[]) => Observation[]`（安全头/cookie 标志/CORS/CSP/信息披露/服务端指纹/秘密模式/可疑参数），非 LLM——结果可复现、可单测、可审计。
- **假设由 LLM 提出但结构化**（SecurityHypothesis：category/title/rationale/basedOnFlowIds/endpoint/parameter/confidence/priority）——推理链显式化、可追溯。
- **Active 测试 = 最小请求集 + 基线对比**（如 IDOR：换 id 重放一次，比对响应差异），**绝不 payload 喷洒**；必须 Tier 3 门控 + scope.activeTesting。
- **`Finding.status='confirmed'` 必须存在 evidence flowIds**——security_report_finding 工具层强制校验；LLM 纯推测最多到 suspected/needs_review（毕设原则 9）。
- Finding 去重键：(category, endpoint, parameter)；WSTG ID 映射。

## 理由
用户原则 8"Security Tool 不直接决定漏洞成立，由 Reasoning + Evidence 判断"+ BurpAI/HackingBuddyGPT 的证据驱动模式。确定性 passive 模块保证可测试性；LLM 负责它擅长的（假设生成、上下文关联、解释），机器负责它擅长的（确定性检查、字节比对）。

## 后果
+ 每个 Finding 有完整证据链（Observation→Hypothesis→Test→Evidence），报告可信。
− 比全量 fuzz 慢——这是刻意的（授权环境+学术评估以证据质量为指标，不以数量为指标）。
