# ADR-004：安全层 = ToolGuard 显式包裹 + 代理双点强制 + fail-closed

状态：已接受（2026-09-07）

## 决策
所有自定义工具的 `execute()` 第一行经 `ToolGuard.invoke(toolName, params)`，管线：`scopeCheck → policyCheck → rateLimit → approval(如需) → 执行 → audit`。因为工具全部自写，包裹法 100% 可达，不依赖框架钩子。**同时在代理 addon 的 request 钩子做第二重 scope 强制**（纵深防御：浏览器流量必经代理）。未注册策略的工具 = 拒绝（fail-closed，借 burp-ai-agent 未知工具 fail-closed 设计）。

Pi 本身无权限系统/沙箱（官方文档明确"以启动用户权限运行"，且拒绝进程内伪沙箱）→ 安全层完全自建是唯一选项。

## 工具信任分级
| Tier | 行为 | 工具 |
|---|---|---|
| 0 自动（只读有界） | 直接执行+审计 | browser_get_page/get_state、traffic_list、traffic_get(正文经脱敏)、security_observe |
| 1 自动（变更浏览器状态） | scope 检查+轻限速 | browser_navigate/click/type/press_key/back/reload/screenshot/wait |
| 2 会话级确认 | 批量攻击者可控内容入上下文 | traffic_search(bodies)、raw 正文模式 |
| 3 每次确认+activeTesting | 向目标发请求 | traffic_replay、security_execute_test |

## 组件
ScopeManager（host/port/protocol 白名单，支持通配；默认仅 localhost/127.0.0.1）；PolicyEngine（声明式规则表 tool→tier+条件）；ApprovalManager（CLI / WebSocket UI 双后端，超时=拒绝）；RateLimiter（per-host token bucket + 全局 maxRequestsTotal）；AuditLogger（append-only JSONL + SQLite 双写）；SecretRedactor（出 LLM 上下文前脱敏 Cookie/Set-Cookie/Authorization/password|token|secret 形态值；原始字节完整存库保证据）。

## 理由
双权威点各自独立生效：代理管"流量能不能出"（浏览器唯一出口），ToolGuard 管"工具能不能做"（Agent 唯一行动出口）。burpwn 的负结论（无 scope 白名单）证明这事不会免费获得。

## 后果
+ 授权边界与审计是硬保证而非提示词约束；毕设 Innovation 6（Safety-aware）落地。
− 每个新工具必须声明策略——门面提供集中策略表+启动时校验（未注册策略的工具拒绝装配）。
