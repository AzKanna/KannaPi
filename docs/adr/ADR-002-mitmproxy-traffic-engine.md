# ADR-002：流量引擎 = mitmproxy 子进程 + Python addon + WebSocket 桥

状态：已接受（2026-09-07）

## 决策
Node 后端 spawn `mitmdump --listen-host 127.0.0.1 --listen-port 8080 -s flow_sink.py`（常规代理模式）。addon 用 async 钩子（`request/response/error/websocket_message/http_connect`）把 flow 序列化为 JSON，经内部 asyncio 队列（不阻塞代理热路径）推送至 Node 的 WS 服务器（127.0.0.1:8081）。Node 侧统一赋 flowId、做动作关联、写 SQLite。**scope 白名单在 addon `request` 钩子内强制**（出范围 → 合成 403 + SCOPE_VIOLATION 事件上报）。浏览器：`newContext({ proxy:{server}, serviceWorkers:'block', ignoreHTTPSErrors:true })`（实验室模式；高保真模式可配 certutil 装 CA）。LLM API 流量不过代理（仅浏览器 context 设代理，天然隔离）。

## 理由
- mitmproxy 的 HTTPS MITM 可靠性与捕获完整性最优（逐 SNI 证书、上游证书嗅探、H1+H2+WS、CONNECT 可见、pinning 回退）；Windows pip 即装；WS 桥有十年先例（mitmproxy-node 模式，claude-capture 2026 验证同拓扑含 Windows）。
- **Playwright 默认强制代理 loopback**（`shouldProxyLoopback()` 加 `<-loopback>`）→ localhost:3000 靶场流量可捕获，无需特殊配置。
- Playwright 网络事件只作**关联用的次级信号源**（字节级真相在代理）。

## 被否方案
1. **Node 原生 MITM 库**：http-mitm-proxy 无 HTTP/2 且 2023 停更、87 open issues；whistle 可用但 JS+规则/插件制，程序化逐流导出要写插件，类型体系弱。
2. **纯 Playwright 拦截作为唯一引擎**：无 CONNECT/TLS 层；`headers()` 隐藏 cookie/安全头；SW 流量盲区；重定向正文不稳——对安全分析是硬伤。

## 许可
mitmproxy=AGPL-3.0：子进程 CLI 调用；flow_sink addon 为自有代码（~150 行序列化+推送）运行于其进程内；论文随源码公开满足 AGPL 精神；接口隔离于 services/proxy，必要时可换引擎。

## 后果
+ 捕获质量与 burp 同级；scope 在"所有浏览器流量的必经之路"上强制（权威点）。
− 双进程拓扑（Node+Python）：要求 Python 3.10+ 与 pip install mitmproxy；跨进程 JSON 契约需在 @kanna/shared 镜像定义。
