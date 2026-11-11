# KannaPi 通用 Agent 工作台快速开始

## Windows 桌面版

已经生成安装程序时，直接运行 `release/KannaPi-0.2.1-Setup-x64.exe`，安装后从桌面或开始菜单打开 KannaPi。桌面版会自动启动后端和界面，不需要保留终端窗口。

从源码构建安装程序：

```powershell
pnpm desktop:dist
```

桌面版的数据保存在 `%APPDATA%/@kanna/desktop/data/`。详细构建、数据路径和 Traffic 依赖说明见 `docs/DESKTOP.md`。

如果界面显示偏小，进入左侧齿轮的 **Settings → Appearance**，可选择 80%–140% 的整体缩放比例。桌面版会立即应用并自动记住该设置。

## 首次配置

首次打开会自动进入统一的 **Settings** 工作区：

1. 填 OpenAI 兼容接口的 Base URL，例如 `https://api.example.com/v1`。
2. 填 API key，然后点击 **Discover models**；KannaPi 会读取接口的 `/models` 列表。
3. 从自动发现的列表选择模型。若服务不提供模型目录，也可以直接填写 Model ID。
4. 保存后可从左侧齿轮重新进入设置，用 **Test saved connection** 验证连通性。
5. 创建 Project，绑定一个已经存在的本地目录。
6. 创建 General Agent，默认选择 `read-only` 工具配置。

模型目录写入 `data/models.json`，凭据写入 `data/auth.json`。后端 API 只返回 `keyConfigured`，不会把 key 返回浏览器。

## Agent 控制

- Agent 空闲时按 Send 开始一轮任务。
- 发送按钮左侧可以为当前 Agent 选择已经配置且具有凭据的模型；切换结果会持久化。
- Agent 运行时按 Steer，让补充指令在当前 turn 后优先处理。
- Agent 运行时按 Queue，让补充问题等当前思路自然完成后再处理。
- 对话框左下角的 **＋** 可一次选择最多 10 个附件，每个不超过 20 MB；发送前可逐个移除。文本、代码和配置文件会作为受控上下文交给 Agent，视觉模型会原生接收图片，其他文件会提供本地保存路径供具有读取权限的 Agent 使用。
- 左侧 Workspace 下的 **Attack Graph** 会在任务结束后，把可观察的执行记录归纳成目标、分析、行动、发现、判断和结果图；点击节点可查看完整摘要，最新执行图会持久化保留。
- Stop 调用 Pi `session.abort()`；已经完成的对话仍保留，可以继续发送消息。
- 对话保存于 `data/agent-sessions/*.jsonl`，重启 `serve` 后可继续。
- 附件保存在 `data/attachments/<agent-id>/`，元数据保存在 SQLite；历史消息中的附件卡片可以再次打开或下载。

## 工具权限

- `chat`：纯对话，无工具。
- `read-only`：读取和搜索工作区，默认。
- `workspace`：额外允许编辑和写文件。
- `full`：额外允许本机 shell，以及当前项目中由用户显式连接的 SSH 主机；Windows 本机使用 PowerShell，其他平台使用 Bash。只有明确需要时选择。

当前主工作台不会自动加载浏览器、流量或渗透工具。旧安全测试代码保留为后续 capability pack。

## Skills

选择一个 Agent 后，点击左侧齿轮进入 **Settings → Skills**：

1. 在 **Skill path** 中填写 `SKILL.md` 文件，或填写包含一个或多个 Skill 的目录。
2. 点击 **Attach Skill**。界面会显示 Pi 实际识别到的 Skill 名称。
3. 下一条消息会新建运行时并加载这些 Skill；正文由 Pi 在匹配任务时按需读取。

Skill 必须包含有效 frontmatter，例如：

```markdown
---
name: release-helper
description: Checks and prepares a project release
---

# Release helper

Run tests before creating release artifacts.
```

Skill 需要读取 `SKILL.md`，因此不能挂到 `chat` 权限的 Agent；请选择 `read-only`、`workspace` 或 `full`。

## MCP Servers

进入 **Settings → MCP Servers** 后可以配置三种传输：

- **Local stdio**：填写可执行命令，参数每行一个；需要的环境变量按 `KEY=value` 每行一个填写。
- **Streamable HTTP**：填写完整 MCP endpoint，例如 `http://127.0.0.1:3000/mcp`。
- **Legacy SSE (Burp)**：兼容仍使用 HTTP+SSE 的 MCP Server。Burp Suite 官方 MCP 扩展默认可填写 `http://127.0.0.1:9876`。

点击 **Add & test server** 后，KannaPi 会完成 MCP 握手并发现工具。成功后工具以 `mcp__server__tool` 的名称进入 Pi 会话；失败时配置仍会保存，并显示具体错误，可用 **Test** 重试。

环境变量的值只保存在本地 SQLite 中，Web API 与界面只显示变量名。stdio MCP Server 是由 KannaPi 启动的本机子进程，应只添加你信任的命令。修改 Skill 或 MCP 配置前需要先停止正在运行的 Agent。

## SSH 工作区

左侧 **Workspace → SSH** 提供项目级远程主机管理：

1. 点击 **Add host**，填写主机、端口、用户名，并选择密码或私钥认证。
2. 私钥认证填写的是运行后端这台机器上的私钥绝对路径；密码和私钥口令只在点击 Connect 时发送并保存在当前连接内存中，不写入数据库。
3. 第一次连接会显示服务端主机密钥的 SHA256 指纹。应与主机管理员或可信来源核对，确认后才会固定保存；以后指纹变化会拒绝连接。
4. 连接成功后可在底部运行非交互命令，输出、退出码、执行者与时间会保存到项目数据库中。单条命令默认 30 秒超时，最长 120 秒，输出最多保留 128 KiB。
5. `full` 工具配置的 Agent 会获得 `ssh_list_hosts` 和 `ssh_exec`；它只能看到当前项目的主机，也只能执行已经由用户在 SSH 工作区连接的主机。`chat`、`read-only`、`workspace` Agent 不具备 SSH 执行能力。

当前版本不提供交互式 TTY、端口转发或文件传输。需要持续交互的程序应改用可一次执行完成的命令或脚本。
