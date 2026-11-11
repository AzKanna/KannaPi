# KannaPi Windows 桌面版

KannaPi 桌面版使用 Electron 包装现有 React/Vite 界面，并在主进程中直接启动 Node.js 平台服务。用户不再需要分别打开后端终端、Vite 终端和浏览器。

## 开发运行

```powershell
pnpm desktop:dev
```

该命令会先完成 TypeScript 与 Web 生产构建，再打开 Electron 窗口。桌面窗口仍通过本机回环地址访问 API 和 WebSocket，但端口由系统随机分配，不固定占用 `4173` 或 `8081`。

## 生成 Windows 安装程序

```powershell
pnpm desktop:dist
```

生成结果：

```text
release/KannaPi-0.2.1-Setup-x64.exe
```

如果只需要未安装的调试目录：

```powershell
pnpm desktop:pack
```

输出位于 `release/win-unpacked/`。

## 数据位置

安装目录被视为只读。模型配置、API Key、项目、会话、附件和数据库保存到 Electron 的用户数据目录：

```text
%APPDATA%/@kanna/desktop/data/
```

首次启动还会创建默认工作目录：

```text
%USERPROFILE%/Documents/KannaPi Workspace/
```

卸载程序默认不会删除用户数据。

## 统一设置页

桌面版左侧齿轮会打开完整的 Settings 工作区：

- **LLM & Models**：配置 OpenAI 兼容 Base URL 与 API Key，并通过服务端 `/models` 自动发现模型；接口不提供目录时仍可手工填写 Model ID。
- **MCP Servers**：为当前选中的 Agent 管理 stdio、Streamable HTTP 和 legacy SSE 服务。
- **Skills**：为当前选中的 Agent 挂载本地 `SKILL.md` 文件或目录。
- **Appearance**：在 80%–140% 之间等比缩放整个桌面界面，设置会自动保存在当前电脑。

LLM 配置属于当前 KannaPi 安装，MCP 与 Skill 继续按 Agent 隔离。界面切换使用轻量过渡动画，并遵循 Windows 的“减少动画”辅助功能设置。

## Traffic Workspace

安装包会携带 Agent 沙箱所需的 Node.js 与 AppContainer 辅助程序；普通 Agent 和沙箱功能不需要另装 Node.js 或 .NET 编译器。它也会携带 `flow_sink.py` 和 `requirements.txt`，并在启动时复制到 `%APPDATA%/@kanna/desktop/proxy/`。当前版本没有把 Python 与 mitmproxy 运行时塞进安装包，因此 Traffic 实时抓包仍需要本机 Python 3.10+。

若界面显示 mitmproxy unavailable，可在 PowerShell 中执行：

```powershell
$proxyDir = Join-Path $env:APPDATA "@kanna\desktop\proxy"
python -m venv (Join-Path $proxyDir ".venv")
& (Join-Path $proxyDir ".venv\Scripts\python.exe") -m pip install -r (Join-Path $proxyDir "requirements.txt")
```

完成后重新启动 KannaPi。其他工作区不依赖 Python。

## 桌面安全边界

- Renderer 启用 Chromium sandbox、context isolation，并关闭 Node integration。
- React 页面和 REST/WebSocket API 使用同一随机本地源。
- 非本地 HTTP/HTTPS 链接交给系统浏览器打开，窗口本身不会导航到远程页面。
- 应用使用单实例锁，退出窗口时会关闭 Agent、SSH、Traffic 与数据库资源。
- 当前安装包未进行商业代码签名，Windows SmartScreen 可能显示未知发布者提示。
