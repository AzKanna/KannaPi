# ADR-011：先做通用 Pi Agent 平台，渗透作为能力包

- 状态：Accepted
- 日期：2026-09-07

## 决策

KannaPi 的主产品形态采用 BreachWeave `pentest` 分支式的本地项目工作台：Project 组织工作空间与 Assets，Agent 会话是长期存在、可恢复、可实时干预的一等资源。

第一阶段不实现 Planner/Solver/Observer 等渗透专用多 Agent 编排，也不让扫描 CLI 控制应用生命周期。Pi 首先作为通用 Agent 运行，默认不加载渗透提示词和渗透工具。浏览器、流量、安全分析以后以 capability pack 的形式挂载到具体 Agent。

## 第一阶段闭环

1. 创建项目并绑定本地工作目录。
2. 为项目创建通用 Agent，选择系统提示词与工具权限配置。
3. 在 Web 中实时对话，显示文本流和工具执行状态。
4. Agent 运行中支持 steer、follow-up 与 abort。
5. 项目元数据落 SQLite，对话落 Pi JSONL；服务重启后继续会话。

## 权限配置

- `chat`：无工具。
- `read-only`：read/grep/find/ls，默认配置。
- `workspace`：在只读基础上允许 edit/write。
- `full`：额外允许 bash，必须由用户显式选择。

## 保留与推迟

保留现有 Browser、Traffic、Scope、Policy、Approval、Audit、Finding 等底层包和旧 `scan` 命令，但它们不再是主界面的默认能力。

推迟项目级自动规划、多 Agent 调度、Attack Flow、共享 Memory/Idea、渗透报告闭环；这些能力建立在通用会话闭环稳定之后。

## 后果

旧 Phase 1 的“自动访问目标并产生 Finding”验收标准不再代表产品 MVP。新的 MVP 验收标准是项目/资产/Agent 管理、流式对话、工具可见性、运行中控制和断点续聊。
