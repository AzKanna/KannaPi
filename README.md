# KannaPi

KannaPi 是一个面向网络安全学习和授权实验的桌面工作台。它将 HTTP 流量采集、PCAP 离线分析、请求重放、被动分析、资产查询、编解码、SSH 和模板扫描组织到项目中。各工作区可按需将证据交给基于 Pi SDK 的 Agent。

## 安装与启动

双击 `KannaPi-0.2.1-Setup-x64.exe`，按安装向导完成安装。之后从桌面快捷方式或 Windows 开始菜单打开 KannaPi。安装程序适用于 Windows x64。

在 Settings 中配置自己的模型服务。FOFA、DeepSeek、NVD、SSH 和 Bench 按需配置。Nuclei 工作区使用本机 PATH 中的 Nuclei。

Bench 使用授权环境提供的 VPN 健康检查地址。运行应用前，在 Windows 用户环境变量中设置 `KANNAPI_BENCH_VPN_URL`。通过 Bench 界面配置对应的 API 地址和令牌。

## 目录

- `apps/web` 是 React 工作区。
- `apps/server` 是本地服务和工作区 API。
- `apps/desktop` 是 Electron 桌面外壳。
- `packages/agent` 是 Pi SDK 封装、工具和会话控制。
- `services/proxy` 是 mitmproxy 插件及其依赖。

更多说明见 [快速入门](docs/QUICKSTART.md)、[桌面运行](docs/DESKTOP.md) 和 [PCAP 分析](docs/PCAP-ANALYSIS-ITERATION.md)。

源码开发和打包命令见桌面运行文档。`pnpm build` 构建项目，`pnpm test` 运行测试。测试用例中的模拟数据仅用于验证代码行为。运行数据由应用在本机生成。
