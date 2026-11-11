# 研究报告 2：流量感知安全代理与 Traffic Engine 选型

> 调研日期：2026-09-07 · 全部结论经 GitHub 源码 / 官方文档 / npm registry 验证，未验证项已标注。

## 1. burpwn（首要架构参考）

**https://github.com/own2pwn-fr/burpwn** — "Transparent intercepting proxy + sandbox + agent interface for AI-driven web pentesting"。Rust、**AGPL-3.0-only**、v0.4.0、**仅 Linux**、单二进制。自述"既是 Burp 又是 tshark，但由 agent 驱动"。

### 架构（9 crate）
- `burpwn-proxy`：MITM 引擎（rustls + rcgen 逐 SNI 现签叶子证书、HTTP/1.1+2、WS 按消息捕获、SSE/chunked 流式 tee 不缓冲、证书固定目标回退 TLS passthrough、QUIC 在沙箱内 fail-fast 拒绝强制降级 TCP）
- `burpwn-sandbox`：rootless 隔离——每命令独立 Linux user/net namespace，nftables REDIRECT 强制入代理，bubblewrap 文件系统隔离；"子网命名空间无真实出口，一切经代理"
- `burpwn-store`：SQLite(WAL)、**内容寻址正文去重**、FTS5 全文搜索、**单写者任务离热路径**
- `burpwn-mcp`：42 个 MCP 工具（session/req/workspace/tag/note/group/replay/fuzz/compare/encode/decode/intercept_*）
- `burpwn-wrap`：shell 钩子把 agent 每条命令自动改写为 `burpwn exec -- <cmd>`

### 关键设计（KannaPi 直接借鉴）
1. **exec 关联信封**：`burpwn exec --json -- <cmd>` 把 `{exit_code, exec_id, captured_request_ids}` 写到 **fd 3**（不污染 stdout）→ KannaPi 翻译为"每个浏览器动作返回 capturedFlowIds"。
2. **零流量逃逸检测**：`session stats` 标出"网络命令却零捕获"——"最坏情况：你以为有证据其实没有"。
3. **机器输出契约**：检测 stdout 是否 TTY——终端给彩色表格，管道给 **TSV 无表头无截断**；`--json` 单行为稳定机器契约；空结果打印空。
4. **列表行/详情分离**：FlowRow（便宜，给 list 工具）vs FlowDetail（按需加载）——token 预算核心。
5. **Agent 流量排除在外**：agent 进程在沙箱外，LLM API 流量"excluded by construction"。

### 重要负结论
**burpwn 没有目标白名单**——隔离只保证"捕获完整性+宿主安全"，不限制可攻击主机；`intercept scope` 只缩小"阻塞拦截"范围。无速率限制、无审批门。**KannaPi 的 Scope 强制必须自建**（我们做在 addon request 钩子 + ToolGuard 两处）。

## 2. burp-ai-agent（six2dez）

Kotlin Burp 扩展（Montoya API）。**内置 MCP server**（Ktor，127.0.0.1:9876，bearer token，SSE）+ 12 个 AI 后端。

- **59 个 MCP 工具，每个带两个独立门**：`unsafeOnly`（能力轴，需开 Unsafe Mode）+ `secTier`（信任轴 AUTO/CONFIRM/CONFIRM_EACH）。**未知工具名 fail-closed 永远确认**。`proxy_http_history` 虽只读仍 CONFIRM——"返回的是批量攻击者可控流量"（防提示注入外泄）；`http1_request` 等为 CONFIRM_EACH。
- 流量→AI 上下文：`LimitedStringBuilder`（字节感知截断）、分页、Max Body Bytes 上限；**无 token 数预算（字节/条目预算）**。
- 隐私：PrivacyMode STRICT（HKDF 匿名化主机）/BALANCED（脱敏 Cookie/token）/OFF；`Redaction.apply()` 是所有出站数据的强制路径；`PersistentPromptCache`（SHA-256 键的脱敏提示 LRU，绝不重发相同提示）。
- 审计：append-only JSONL + SHA-256 完整性哈希。
- 被动/主动分离：PassiveAiScanner（后台 3-5 请求/批、置信度 ≥85 才建 issue）vs ActiveAiScanner（主动确认、风险过滤）。

## 3. BurpAI（srinivasans13）

Java Burp 扩展。11 个工具的紧凑集：
- `execute_http_request`（一切请求经 Burp 引擎→全审计）、`spider_links`、`extract_from_response`（正则提取 `{{变量}}`，CSRF/session）、`set_variable/get_variable`、`fuzz_parameter`（**逐 payload 记录 status/长度/耗时；时序异常=绝对 >3s 或 >3×基线**）、`decode_encode`、`search_in_response`、`get_sitemap`（**挖掘代理历史做被动攻击面发现，不发新请求**）、`finish_run`、`report_vulnerability`（severity/location/PoC/impact/remediation/**evidence request IDs**）。
- `AgentStateSnapshot`：每轮把累积状态转紧凑结构化信号注入提示。
- `AttackGraph`：端点×参数×已测 payload 类型的确定性图——**避免重复测试**。

## 4. Traffic Engine 选型（KannaPi 采纳结论）

| 维度 | mitmproxy(Python 子进程)+WS 桥【采纳】 | Node 原生(http-mitm-proxy/whistle) | 纯 Playwright 拦截 |
|---|---|---|---|
| HTTPS 拦截 | **最优**：逐 SNI 证书、上游证书嗅探、pinning 回退、H1+H2+WS | http-mitm-proxy 无 H2、2023 停更；whistle 可用但 JS+插件制 | 无（浏览器自管 TLS） |
| 正文完整性 | **完整**（含 headers、CONNECT 可见） | 完整 | 部分：`headers()` 隐 cookie 头、SW 流量盲区（须 `serviceWorkers:'block'`）、重定向正文不稳 |
| 动作关联 | 间接（Node 侧做窗口+事件匹配） | 同左 | 原生最好（frame/initiator）但只是"浏览器视角" |
| Windows | **pip 即装**（claude-capture 验证同拓扑） | 纯 Node 最简 | 最简 |
| 结论 | **捕获引擎** | 备胎 | **只作关联次级信号源** |

### mitmproxy 关键事实（已验证）
- 无头运行：`mitmdump -s addon.py`（脚本热重载）；`--set opt=value`；配置持久化 `~/.mitmproxy/config.yaml`；**常规代理模式**默认 127.0.0.1:8080。
- **Addon 事件钩子**（46 个，关键的）：`requestheaders/request/response/responseheaders/error/http_connect`、`websocket_start/message/end`、`client_connected` 等；钩子可 `async def`（推荐）；addon=任意带钩子方法的 Python 对象，脚本暴露 `addons=[...]`。
- 时间戳：`flow.request.timestamp_start/end`（墙钟）——关联窗口的数据基础。
- 正文流式警告：`stream_large_bodies` 开启则正文不存储；`hardump` 退出时落盘且钉内存。
- 证书：首跑生成 `~/.mitmproxy` CA（含 Windows 用 p12）；`mitm.it` 魔法域安装；上游证书嗅探默认开。
- Scope 强制点：`block_global` 默认 true（仅本地客户端）；`block_list` 或自定义 `request` 钩子合成 403——**我们选自定义钩子（可发 SCOPE_VIOLATION 事件）**。
- 实时导出三通道：addon 内起 WS 服务器（mitmproxy-node 模式）/ addon POST 到 Node / NDJSON 文件 tail。**KannaPi：Node 起 WS 服务器，addon 作客户端**（Node 拥有 ID 分配与存储）。
- 先例：`jvilk/mitmproxy-node`（npm `mitmproxy`，2020）、`@oxygenhq/mitmproxy-node`（2021 fork）、`claude-capture`（2026，含 Windows 的"spawn mitmdump+addon+子进程 proxy env"完整拓扑）。

### Playwright 关键事实（已验证）
- 每上下文代理：`browser.newContext({proxy:{server:'http://127.0.0.1:8080'}})`——CDP `Target.createBrowserContext({proxyServer})` 级实现。
- **`shouldProxyLoopback()` 默认给 bypass 列表加 `<-loopback>`**：Chromium 默认不代理 localhost，Playwright 反转此行为——**localhost:3000 的 Juice Shop 会被捕获**（除非显式 bypass 或设 `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`）。
- `serviceWorkers:'block'` 必设（SW 会绕过路由/事件）；`headers()` 不含 cookie/安全头（用异步 `allHeaders()`/`headersArray()`）。
- CA 证书：`ignoreHTTPSErrors:true`（实验室模式）或 `certutil -addstore root`（高保真模式）。
- `bypass` 选项可把 LLM API 域排除出捕获（纵深防御）。

## 5. 许可注记
mitmproxy=AGPL-3.0：KannaPi 以子进程 CLI 调用，flow_sink addon 为自有代码（仅序列化+WS 推送，~150 行）运行于其进程内；论文随源码公开即满足 AGPL 精神；接口隔离在 services/proxy，可换引擎。burp-ai-agent/BurpAI=MIT 可参考；burpwn=AGPL **只借思想零代码**。
