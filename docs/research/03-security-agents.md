# 研究报告 3：安全 Agent 架构、靶场与学术工作

> 调研日期：2026-09-07 · 经源码/官方页面验证，未验证项已标注。

## 1. CAI — Cybersecurity AI（aliasrobotics/cai）

**已归档**（默认分支 `archive`，v1.1.5；继任者为商业 CSI）。Python；agent 运行时是 vendored 的 OpenAI Agents SDK fork。7 支柱：Agents/Tools/Handoffs/Patterns/Turns/Tracing/HITL。

**可借鉴模式**：
1. **声明式 agent 记录**：agent = {name, description, instructions(markdown 文件), tools, handoffs, guardrails, model}；factory 用 pkgutil 扫描注册——加 agent 零接线。提示词放版本化 markdown + "micro profile" 分层组合。
2. **编排器纪律**：orchestration_agent 的工具只有 check_available_agents/run_specialist 等——**刻意不给 fetch_url**（"会导致它自己试图解题的长思考循环"）。
3. **Worker 预算**：每 worker 最大轮次 1-32（默认 6）、"每轮至多一次工具调用"、输出上限 4k/合计 8.5k 字符、输出包 `<orchestrator_internal>` 标记禁止外泄、预置"决策段落"模板。`run_dual_approach_contest` 双 worker 竞争假设。
4. **工具注册表 + agent→类别 ACL**：工具按 kill-chain 阶段分类（reconnaissance/web/exploitation/...）；每个 agent 授予类别而非裸工具列表；文档明示成本：**每多一个工具 schema ≈120-150 token/轮，二次方累积**。
5. **三层记忆**：本地上下文对象（注入依赖，不入 LLM）/ 对话历史 / `<compacted_context>` 压缩摘要 + 面向渗透的 findings 抽取（IP/CVE/artifact 路径/待执行命令正则）+ agent 切换 handoff 块。keep-recent 窗口 4-16。
6. **零工具 Reporter**：`tools=[]`——"Reporter 只综合对话生成 HTML，避免跟随聊天历史中残留的渗透指令"。优雅的权限分离。
7. **Guardrail tripwire + 注入防御**：输入输出 guardrail 返回 tripwire_triggered 即中断；正则 + Unicode 同形异义归一化 + 小模型结构化判定。
8. web_pentester 提示词编码的方法论：明确目标范围 → 侦察与映射 → 威胁建模（优先假设：IDOR/注入/SSRF/OAuth/业务逻辑）→ 假设驱动测试（plan→act→observe→adapt）。

## 2. HexStrike AI（反面教材清单）

morpheusc/HexStrike-AI（fork 自 0x4m4）。实质 = **两个巨型文件**：`hexstrike_server.py`（643KB Flask）+ `hexstrike_mcp.py`（220KB，147 个 @mcp.tool）+ 15KB requirements.txt。"150+ 工具/12+ agent" 的真相：
- **~200 个 REST 端点全是对外部 CLI 的参数→命令字符串→subprocess 包装**（nmap/gobuster/sqlmap/hydra...），LLM 必须解析原始 stdout。
- **"AI Agent" 是普通 Python 类**（IntelligentDecisionEngine 是硬编码效果浮点查表：`{"nuclei":0.95}`；TechnologyDetector 是字符串匹配；`security_score = 100 - 10*issues` 拍脑袋公式）。
- 无会话/状态/记忆/任务树/报告——单例对象存零散状态。
- 唯一好原语被浪费：Selenium CDP performance log 捕获网络——但只留最近 50 条 response-only 记录，无请求体、无动作关联。

**KannaPi 明确避免**：CLI 包装集合、字符串拼 shell、"AI"营销静态查表、无状态、捏造评分、展示逻辑混业务逻辑、一次性浏览器检查（固定 50 links/20 scripts 截断）。

## 3. pi-skill-pentesting（soulofzephir）

Pi 技能（npm `@soulofzephir/pi-skill-pentesting`，MIT）。组织方式 = `SKILL.md`（YAML frontmatter name/description 关键词触发）+ `checklists/`（headers/owasp/ports/injection/exposed-files/cors/jwt/graphql/api-security/subdomain/websocket/cloud-metadata/sensitive-data）+ `tools/`（bash/ps1 薄扫描器）+ `reports/template.md`。**16 阶段方法论**：侦察→安全头(9个)→暴露文件→子域→端口→SSL→认证→API→WebSocket→云元数据/SSRF→敏感数据→注入(SQLi 5型/XSS 4型/命令/XXE/LDAP/SSTI)→CORS→JWT→GraphQL→OWASP Top10。**零 agent 代码——方法论即提示词**。KannaPi 的 WSTG checklist 技能采用此载体形式（自写内容）。

## 4. OWASP Juice Shop（主靶场）

- 运行：源码 `npm install && npm start` / 解包发行版 `npm start` / Docker `bkimminich/juice-shop` → **http://localhost:3000**。
- **自愈**：每次启动 DB 重置重灌——可重复实验。
- **116 挑战/16 类**：Injection(14)/Sensitive Data(17)/Broken Access Control(12)/Improper Input Validation(12)/XSS(9)/Broken Auth(9)/Vulnerable Components(9)/XXE(2)/Unvalidated Redirect(2)/…；难度 1-6 星。
- **服务端自动检测利用 + Score Board** = 免费 ground-truth oracle（HackingBuddyGPT 手工实现的东西 Juice Shop 白送）；`juice-shop-ctf-cli` 可导出 CTFd。
- 13 个 Hacking Instructor 教学挑战；35 个编码挑战（Find-It/Fix-It）。

## 5. OWASP WSTG v4.2

- 测试 ID `WSTG-<类>-<号>`（引用建议带版本 `WSTG-v42-...`）。
- 12 类：Information Gathering(10)/Configuration & Deployment(14)/Identity Mgmt(5)/Authentication(11)/Authorization(7)/Session Mgmt(11)/Input Validation(33)/Error Handling(2)/Weak Crypto(4)/Business Logic(11)/Client-side(~15)/API(6)。
- **被动/主动不是 WSTG 原生全局结构**——是我们在其上叠加的设计分层（被动=分析已捕获流量/DOM；主动=发送构造请求）。

## 6. 学术工作（毕设引用库）

| 工作 | 贡献 | 对 KannaPi 的意义 |
|---|---|---|
| PentestGPT (USENIX Sec'24, arXiv:2308.06782) | 三协作 LLM 会话(reasoning/generation/parsing)+任务树 PTT；端到端 +228.6% | 上下文丢失是核心痛点→状态模型动机 |
| HackingBuddyGPT (arXiv:2310.11409) | ground-truth 验证(task_solved 不信任自述)、run limits(rounds/tokens/cost/duration)、append-only trace、planner/executor 非对称记忆、有界子代理 | 评测方法论直接采用 |
| CAI (arXiv:2504.06017) | 模块化 agent+工具+HITL；CTF 3600×/156×；自主性分级(arXiv:2506.23592) | 架构+自主性分级引用 |
| "Hacking the AI Hackers via Prompt Injection" (arXiv:2508.21669) | 安全 agent 自身可被注入；四层防护 | **安全层动机的核心引用** |
| PentestEval (arXiv:2512.14233) | 346 任务六阶段基准；端到端管道仅 ~31% | 分阶段评估指标设计 |
| "How Reliable Are AI Attackers" (arXiv:2605.30096) | 400 次运行高方差 | 重复运行报告方差（T13） |
| HackSynth (arXiv:2412.01778)、Pentest-R1、xOffense、Red-MIRROR、MazeRunner | planner/executor、RL、多 agent+共享记忆、非线性编排 | 相关工作章节 |
| "Baselines Before Architecture" (arXiv:2607.13085) | XBOW 上朴素编码 agent 已解大半 | 避免过度归因于特制 harness |
| LLM 渗透综述 (arXiv:2607.02605) | 81 篇(2023-26)分类 | 文献综述枢纽 |

**未能验证**：Enkhidna / ReconAgent 未找到（arXiv/GitHub 均无果）——不要引用。

## 7. 综合架构准则（对 KannaPi）

**借**：声明式 agent+factory；编排器不给侦察工具；worker 预算；工具类别 ACL+最小工具集；三层记忆+渗透向 findings 抽取；零工具 Reporter；guardrail tripwire；每动作捕获流量的 CDP/事件关联（做成一等公民而非 50 条截断）；ground-truth 验证+run limits+JSONL trace；checklist-as-skill；分阶段评估+方差报告。

**避**：CLI 包装蔓延；字符串拼命令；无模型却称 AI；无状态；捏造评分；展示逻辑入业务逻辑；一次性浏览器检查；orchestrator 自带通用工具（自己干不委派）；自动塞满工具 schema（token 二次方成本）；把工具输出文本当指令。
