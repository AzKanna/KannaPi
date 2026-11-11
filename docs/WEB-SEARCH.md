# Agent 联网搜索

入口：**Settings → Web Search**。更新并重启当前桌面开发版后，Agent 可以调用 `web_search` 查询公开资料；工具调用和返回的来源链接会进入现有对话/工具活动记录。

## 使用

- CVE 编号：无需额外 Key，默认开启。例如：“查询 CVE-2024-3094，总结漏洞影响与修复建议，列出来源。”
- 产品漏洞检索：例如：“用 NVD 查询 Apache Log4j 的 CVE。”NVD 关键词以英文产品名为宜，结果是匹配的第一页，不保证最新排序或完整列表。
- 普通网页搜索：在 Web Search 设置填写 **DeepSeek API Key**，保存后让 Agent 搜索厂商公告、修复资料等。使用 DeepSeek 平台的 API Key；若模型服务也使用 DeepSeek，可在此填写同一个 Key。搜索配置独立保存，不会自动读取模型或 FOFA 凭证。
- 设置页有独立测试入口，无需让模型调用；网页搜索会消耗搜索服务的额度，CVE 数据查询不消耗 LLM token。Agent 分析结果仍按模型正常计费。
- Agent 的 read-only、workspace、full 权限档支持此工具；chat 档仍不启用任何工具。保存设置对已有 Session 的下一次搜索生效，无需新建会话。

工具参数：

```json
{"query":"CVE-2024-3094","mode":"cve","maxResults":5}
```

`mode` 可选 `auto`（默认）、`cve`、`web`。`auto` 对完整 CVE 编号使用 NVD，其余查询有 DeepSeek Key 时使用 DeepSeek，没有时只查询 NVD 关键词；不会把 NVD 结果冒充普通网页搜索。DeepSeek 网页查询词最多 128 个 Unicode 字符，支持 `site:`、`lang:`、`after:`、`before:` 等语法。单次返回 1–10 条，每条带 URL、摘要与查询时间。网页搜索使用 `POST https://api.deepseek.com/v1/tools/search`，请求字段为 `query`、`count`、`need_content: false`，优先读取 `summary`，缺失时使用 `snippet`。NVD 记录在提供数据时附带 CVSS（含评分来源）、CWE、发布日期、修改时间和参考链接。

## 安全与边界

### Windows 应用数据重定向兼容（2026-10-01）

Codex/MSIX 环境中的 AppData 路径可能被重定向：两个看似同目录的路径实际落在不同磁盘，首次 `rename` 保存会报 `EXDEV`。现在优先原子重命名，仅在 `EXDEV` 时复制替换并清理暂存文件；复制失败时尝试恢复旧内容，保留 `.tmp` 用于恢复，不对权限等其他错误做绕过。跨盘复制不是原子操作，复制期间异常退出仍有风险。首次保存失败且正式配置不存在时，启动会校验并恢复暂存配置；正式配置已存在时不会自动用失败的修改覆盖它。不移动整个数据目录，也不取消 Windows 文件加密。

运行设置和 Nuclei 状态保存也使用同一兼容逻辑。Nuclei 停止/退出等待子进程结束并完成最后一次保存，避免退出后继续异步写盘。

- 固定 HTTPS API：NVD CVE API 2.0、DeepSeek Search。只查询数据，不访问/扫描搜索结果站点，不抓取任意 URL 或执行下载的脚本。不支持用户指定任意代理/API URL。
- `web_search` 是运行在可信服务端的显式只读 API 代理，不在 AppContainer 内执行；这是沙箱之外的有限联网能力。命令沙箱网络开关不影响搜索，搜索有单独启用开关，MCP/SSH 的沙箱禁用规则不变。
- 查询词会发送给提供方，可能出现在聊天记录中；不要搜索私钥、密码、Token、完整私有请求包或敏感附件。只读不等于不存在对外数据传输。
- API Key 不提供给模型，不通过 GET 设置接口返回，不放进查询 URL；保存在当前数据目录的 `web-search-auth.json`，采用与现有本地配置一致的私有文件方式，**不是加密保险库**。桌面安装使用自己的持久化数据目录，退出后不会丢失。可通过显式移除开关删除已保存 Key。首次无配置文件时也读取 `DEEPSEEK_API_KEY` / `NVD_API_KEY` 环境变量。
- 全局共享限流：NVD 无 Key 查询起始时间至少间隔 6.5 秒，有 Key 至少 0.7 秒；DeepSeek 至少 1 秒。最多 4 个进行中查询，5 分钟缓存最多 100 项；失败不缓存、不自动扣费重试。超限/额度不足会明确报错。设置保存会清空缓存并取消旧查询。
- 查询与限流等待合计最多 35 秒，单次响应最大 2 MB，摘要最多 2000 字符。聊天 Stop 可取消查询；设置测试也有 Cancel search。
- 搜索结果按不可信外部数据处理，提示模型不要遵循网页中的指令、不要为搜索关闭沙箱、回答附来源并区分事实/推断。提示词不是绝对防护；仍需人工核对结论。
- NVD 可能延迟收录，部分 CVE 缺少 CVSS。没有匹配结果/没有评分不代表没有漏洞；CVE 记录不能单独证明资产受影响。网页结果是摘要，不是完整原文核验。

接口：`GET/PUT /api/web-search/settings`、`POST /api/web-search/test`。限制本机连接及本地网页 Origin；没有服务级多用户认证，不应把本地服务暴露到公网。

提供方规范：[NVD CVE API](https://nvd.nist.gov/developers/vulnerabilities)、[DeepSeek Search API](https://api-docs.deepseek.com/zh-cn/guides/search/)。

验证包含：模拟提供方查询、固定端点/Key 脱敏、配置持久化与清除、输入与响应限制、取消/超时/限流等待、真实 Pi 工具循环、沙箱离线时搜索可用与 chat 无工具，以及本地接口来源检查。DeepSeek 接入验证使用模拟响应，包括摘要映射、128 字符边界、旧配置迁移、余额不足、鉴权失败与取消；未使用用户凭据进行真实付费调用。

旧版配置升级：保留搜索启用状态及 NVD Key，移除旧 Tavily 凭证字段，不将其作为 DeepSeek Key。首次未保存 DeepSeek Key 时，可使用 `DEEPSEEK_API_KEY` 环境变量；已保存的空值表示显式移除。
