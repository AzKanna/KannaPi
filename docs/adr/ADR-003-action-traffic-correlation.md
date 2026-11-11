# ADR-003：Action ↔ Traffic 关联 = 时间窗主属性 + 事件匹配次级 + 可选标记头

状态：已接受（2026-09-07）

## 决策
每个 Playwright 动作经 BrowserSession 包裹：`seq++; actionId('act_'+uuidv7); t0=now; await act(); await settle(); t1=now`。`settle()` = `waitForLoadState('networkidle', 5s 容错)` + 300ms 静默宽限（networkidle 对长轮询有盲区）。

三重归因（前两层默认启用）：
1. **时间窗（主）**：代理 flow 的 `request.timestamp_start`（墙钟）落入 `[t0−250ms, t1+250ms]` 内唯一打开的 action → 归属。动作串行执行，窗口几乎不重叠。
2. **事件匹配（次，消歧）**：Node 并行记录 `page.on('request')` 的 `{url, method, wallTime, frame, initiator}`；多候选或后台轮询干扰时按 `(method, URL, ±150ms)` 精确匹配，并把 frame/initiator 元数据绑定到 flow 记录。
3. **标记头（可选，默认关）**：`setExtraHTTPHeaders({'X-Kanna-Action-Id': actionId})`——零歧义但**修改被测流量**，仅调试模式。

双向持久化：flow 行写 `browserActionId`；动作完成后回填 `correlatedFlowIds` 并在工具结果中返回（burpwn fd-3 信封模式）。navigate/click/submit 类动作 `correlatedFlowIds` 为空 → 审计告警 + UI 标红（零流量逃逸检测）。Agent 直发请求（replay/主动测试）走同一代理（source='replay'，关联 testId）。

## 理由
burpwn 验证了"exec_id 关联 + captured_request_ids 返回信封"模式（命令粒度）；KannaPi 将其提升到浏览器动作粒度并叠加 Playwright 事件消歧——这是三个参考项目（burpwn/burp-ai-agent/BurpAI）都没有的**本项目核心创新点（Innovation 3）**。

## 后果
+ Agent 能直接回答"Action #N 产生了哪些请求"——观察→动作→流量→端点的完整证据链。
− 归因有误差可能（长轮询/后台轮询）：以归因率 ≥90% 为 Phase 1 显式验收指标；误差场景有事件匹配兜底。
