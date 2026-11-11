# ADR-009：UI = WebSocket 事件总线 + React/Vite，两步走

状态：已接受（2026-09-07）· 用户确认的选项

## 决策
- 后端把三类事件统一到一条 WS 总线（默认 127.0.0.1:8081）：Pi session 事件（subscribe 转发）、流量事件（flow 入库/关联）、审计事件。
- **Phase 1（T12）**：单页只读实时视图（Agent 动作时间线 + HTTP 流量流 + Findings 列表，cyberpunk 视觉底稿）——只为调试与毕设演示，约 1 天工作量。
- **Phase 8**：完整六页面（Dashboard/Browser/Traffic/Agent Timeline/Findings/Report/Settings），Browser 页四象限布局（Browser | Agent Thought / HTTP Traffic | Findings）。

## 理由
自主 Agent 零可视化极难调试与演示（用户在方案确认时选择"CLI + 极简实时只读页"）。完整 UI 留 Phase 8 维持原 MVP 优先级（用户原则：UI 优先级低于 Agent Engine）。

## 后果
+ 事件总线从第一天就存在（T11 实现），Phase 8 只是前端扩展。
− Phase 1 页面只读无控制（控制功能含审批 UI 属 Phase 6/8）。
