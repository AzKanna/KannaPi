# Agent 沙箱与上下文压缩

本版面向 Windows 10/11，不依赖 Docker、WSL 或 Sandboxie。设置入口：**Settings → Execution & Context**。更改后点击 **Save runtime settings**，设置保存在当前实例的 `data/runtime-settings.json`，重启仍有效。修改前需要结束正在执行或压缩的 Agent。

普通 Agent Chat 现支持 Pi 子 Agent 委派，设置页同一位置提供开关、并发数和超时。详见 [MULTI-AGENT.md](./MULTI-AGENT.md)。

## 1. 隔离执行

默认开启 **Run Agent tools in a sandbox**，工具进程默认离线。

- 每个 Session 建立独立工作副本：`data/sandboxes/<session-id>/workspace`。聊天区的 **Sandbox workspace** 可以查看实际路径。
- `read/ls/find/grep/write/edit/sandbox_exec` 均在 Windows AppContainer 进程中执行，不是仅在提示词中约束路径。
- 工具根据原有 chat/read-only/workspace/full 权限配置开放。只有 full 可以调用 `sandbox_exec`。
- 使用 Windows `cmd.exe` 命令和 `node` 脚本，不支持 PowerShell / bash。需要其他便携工具时，可以先放进选定项目目录，然后创建新的 Session；没有自动映射系统中其他已安装的程序或依赖。
- 工作副本的写入不会修改原始项目，也不自动回写。用户可以自行审阅并复制需要的产物。
- 工具不可继承宿主机环境变量中的 API Key。模型连接仍由可信服务端完成，不受工具进程离线设置影响。
- 子进程继承隔离权限；Job Object 限制 32 个进程、512 MB 总提交内存。文件工具超时 30 秒，命令默认 60 秒、最多 120 秒。中止/超时会关闭 Job，终止剩余子进程。
- 沙箱初始化或执行失败时直接返回错误，**不自动回退到宿主机**。

### 联网与现有能力

需要网络任务时，显式开启 **Allow tool processes to access the network** 并保存。该能力没有目标域名/IP 白名单；未添加 AppContainer loopback exemption，不能保证 localhost 服务可访问。

沙箱模式下，Agent 的 MCP、SSH 自定义工具和 Pi Plugins 不会注册，防止它们仍在宿主机执行而绕过隔离。Pi Plugins 仅对 Full 权限且明确关闭沙箱的 Agent 生效，详见 [PI-PLUGINS.md](./PI-PLUGINS.md)。用户手动操作的 Traffic、Request Lab、SSH、Nuclei 等工作台不属于本次 Agent 执行沙箱的范围，继续按原模式工作。不要把手动工作台或 MCP 连接测试误认为已进入沙箱。

`web_search` 是单独启用的可信服务端只读 API 代理，命令网络关闭时仍能查询固定的 NVD/DeepSeek 接口，不会启用任意宿主命令或 MCP/SSH。它会将查询词发送到外部提供方；可在 Settings → Web Search 关闭，具体范围见 [WEB-SEARCH.md](./WEB-SEARCH.md)。

启用的 Skill 在首次初始化时复制到工作副本的 `.skills/`，说明文件由 Pi 加载，脚本需要使用沙箱工具执行。Skill 列表或工作区路径改变后，创建新 Session 获取新快照。修改已有 Session 的路径不会自动迁移旧快照。

### 快照及安全边界

首次使用时复制项目（没有 Skill 时推迟至首次工具调用，有 Skill 时在加载说明前初始化），排除符号链接、常见凭据目录/文件（如 `.env*`、`.ssh`、`.aws`、密钥文件）、`data`、`node_modules`、构建产物等；单次快照最多 100 MB / 10,000 文件。Skill 目录也有同样的单次复制限制。这是方便分享工作资料的过滤机制，**不是完整的秘密检测器**：放在普通文本中的密码等仍可能被复制，请先检查项目内容。

工作副本及 Windows AppContainer profile 持久保留，便于续聊；删除聊天 Session 不会自动删除副本中的产物。初始化中断留下的未完成快照会拒绝继续使用，创建新 Session 即可。

AppContainer 依赖 Windows 权限与完整性机制隔离进程，属于进程级沙箱，不是虚拟机、Linux 容器或内核隔离。系统共享资源及显式向应用容器开放的资源仍可能可读；没有 CPU 配额和磁盘容量硬限制。不建议运行需要强敌对隔离的恶意样本。

本机需要：独立 Node.js（PATH 中的 `node.exe`，项目要求 ≥22.19）及 Windows 自带 .NET Framework C# 编译器。Electron 打包资源包含 launcher 源码和 worker，首次使用时在可信数据目录编译 launcher。缺失依赖或非 Windows 平台会报告沙箱不可用，不会静默使用宿主模式。

Windows 用户目录下的 Node 脚本使用 `--preserve-symlinks --preserve-symlinks-main`，避免 Node 的入口规范化要求对驱动器根目录进行不必要的读取；文件的实际访问仍受 AppContainer ACL 限制。

## 2. 上下文压缩

使用 Pi SDK 原生 Compaction，不会直接裁剪 JSONL 聊天文件。

- 默认自动开启：达到模型上下文约 80% 时压缩，保留约 12,000 个近期 token。
- 设置页可修改自动开关、50–95% 阈值、近期保留量。实际按模型窗口计算 reserveTokens，至少预留 512 token，近期保留量不得超过剩余窗口的一半；小窗口模型会进一步收紧这些值。
- 自动检查由 Pi 在响应后执行，也支持上下文溢出时的原生 compact-and-retry。单个过大输入仍可能超出模型限制，压缩不能替代附件/输入大小控制。
- 聊天输入区上方显示上下文占用、沙箱状态、**Compress context** 按钮与最近的摘要。自动压缩关闭时仍可手动压缩。
- 执行时可看到 **Compressing…**，点击 **Stop compression** 取消。压缩中不允许发送新消息、删除会话或修改执行配置；失败/取消后保留原上下文并显示错误。
- 摘要保留目标、限制、已验证发现、失败尝试、关键文件及后续步骤。摘要是模型生成的有损信息，需要重要细节时继续参考原始记录。
- 早期内容在下一次模型请求中由摘要代替，近期内容继续直接提供。原始消息和 compaction 记录保存在 `data/agent-sessions/*.jsonl`；聊天界面从原始记录恢复，旧消息仍可查看。
- 压缩完成后旧 usage 无法代表新上下文，因此先显示“usage updates on next reply”；下次响应后更新占用。
- 摘要生成会额外调用已配置模型，可能计费，需要 API 可用。短对话没有足够旧内容时会返回 `Nothing to compact`，这不代表历史丢失。

## 3. API 与验证

- `GET/PUT /api/runtime-settings`：读取/保存全局运行配置。
- `GET /api/agents/:agentId/sessions/:sessionId/context`：上下文状态。
- `POST /api/agents/:agentId/sessions/:sessionId/compact`：手动压缩。
- 原有 `POST .../abort` 同时可以中止压缩。WebSocket `agent_context` 事件推送进度、错误和摘要。

测试：

```powershell
pnpm build
pnpm exec vitest run packages/agent/src/sandbox.test.ts apps/server/src/runtime-features.test.ts apps/server/src/backend.test.ts packages/agent/src/session.test.ts apps/web/src/state.test.ts
```

原生隔离测试验证工作副本读写、宿主文件访问拒绝、环境变量隔离、默认网络阻断、超时终止、重启复用快照及附件目录链接拒绝。模拟模型集成测试验证自动/手动压缩、后续请求使用摘要、历史保留、取消、失败恢复及并发保护；不消耗用户真实模型额度。

参考：[Microsoft AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[实现 AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)。
