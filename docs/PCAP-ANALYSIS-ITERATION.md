# PCAP Analysis 工作台

## 使用入口

左侧 **Observe → PCAP Analysis**，选择 Project 后点击 **Import PCAP**。支持标准 `.pcap` 和 `.pcapng`，上传上限 64 MiB。导入后可切换概览、资产通信图、HTTP、WebShell 线索、可还原口令和导出文件。

对含 TLS 的抓包，打开概览中的 **Import TLS key log**，选择对应会话的 `.log`、`.keys` 或 `.txt` 文件（上限 1 MiB）。应用调用内置 TShark 重组和解析 HTTP，并由原有 Node 解析器提取可处理的 TLS 明文；两种结果合并。key log 只在本机临时文件中供 TShark 读取，调用结束即删除；不会放进项目目录或发给 Agent。解密出的报告仍按 Project 保存在本机，必须视为敏感数据。桌面安装包已附带 TShark 4.6.9、运行库、GPL 许可和对应源码归档，不需要系统另装 Wireshark。

右侧选择一条证据并阅读预览，再勾选确认发送给当前 Project 的 Agent。默认摘要不带口令和原始 HTTP 正文；用户可针对单条 HTTP 或口令勾选“包含原文”，预览后再确认。单条 HTTP 正文最多保留 8 KiB，发送上下文总长最多 10,000 字符，预览内容与实际交给 Agent 的文本内容一致。还可以另选“附上完整原始 PCAP”，查看文件名、字节数和 SHA-256 后二次确认；仅有文件工具的 Agent 可以接收，且运行中的 Agent 需先停止。原文件复制进该 Agent 的本地附件工作区，不会自动作为二进制内容上传到 LLM 提供商的模型 API；模型收到文件路径和结构化分析报告。Agent 不会因为导入抓包而自动联系任何主机。

## 实现与范围

- 解析经典 PCAP 和 PCAPNG 中常见的 Ethernet、原始 IP、Linux cooked、IPv4/IPv6、TCP/UDP；对 TCP 序列号排序重组后解析 HTTP/1.x。图中箭头表示抓包内观测到的源地址到目的地址通信，不推断真实路由跳点。
- 从 HTTP Basic（Base64 编码）、URL 表单中的常见口令字段及明文 FTP USER/PASS 指令提取可直接还原的凭据。匹配 key log 的 TLS 1.3 AES-128/256-GCM、ChaCha20-Poly1305，以及 TLS 1.2 常见 AES-GCM 套件，会先通过 AEAD 认证再交给 HTTP/1.x 分析。缺少密钥、密钥不匹配、TLS CBC、HTTP/2、QUIC、TLS 1.3 KeyUpdate、握手缺失或 TCP 截断的流量不会被标为完整解密；界面显示“未解密”或“部分解密”。不提供“破解任意加密密码”的虚假能力。Wireshark 的[官方 TLS 说明](https://wiki.wireshark.org/tls)解释了 key log 与私钥的适用边界。
- 从完整的 HTTP 响应中提取有附件头或二进制媒体类型的对象，以下载附件形式交给用户；不执行提取出的文件。TShark 主要补足 HTTP 重组和经 key log 解密后可见的 HTTP 记录，原有解析器继续负责抓包结构、通信图、凭据和导出对象。
- WebShell 检测以菜刀常见 `z0` 与 `z1` / eval 包装、蚁剑可自定义参数配合 `asoutput`、`asenc` 或 eval/base64_decode 代码模式，以及冰蝎脚本端点双向不透明正文（含 Base64 包装）为候选线索。名称只是流量假设，不是工具归属证明；特别是冰蝎只给低置信度，单个普通二进制上传不会触发。编码器可自定义，只有密文或被截断时不能保证识别。规则依据 [AntSword 项目说明](https://github.com/AntSwordProject/antSword/blob/master/CHANGELOG.md)、[Behinder 源码](https://github.com/x1a0t/Behinder-Source/blob/master/src/main/java/net/rebeyond/behinder/core/ShellService.java) 等一手资料校验；用户给出的 CSDN 文章当前无法通过检索工具访问，因此未把不可核实的文章细节当成判定条件。
- 按 Project 将原始包、报告和提取文件保存在应用数据目录 `data/pcap-analyses/<project-id>/<analysis-id>/`。列表仅返回摘要，查看单条记录时才读取完整报告；本轮开发中已导入、尚无摘要文件的抓包也能兼容读取。报告可能包含敏感内容，应按本机应用数据保护。
- 解析预算：最多 200,000 包、每个 TCP 方向 2 MiB、总重组数据 24 MiB、最多 1,000 条 HTTP 记录、40 个导出对象且单个对象不超过 2 MiB。TShark 子进程限时 30 秒、输出限 16 MiB、最多 5,000 条 HTTP 字段记录；失败时回退到原解析器并显示状态。超过预算时给出覆盖提示。
- 发行构建脚本从 [Wireshark 官方下载](https://www.wireshark.org/download/win64/)获取 4.6.9 x64 安装包和对应源码，以[官方校验值](https://www.wireshark.org/download/SIGNATURES-4.6.9.txt)核验 SHA-256，再把运行时、[GPL 许可](https://www.wireshark.org/docs/wsug_html_chunked/AppGPL.html)和完整源码归档放入 `resources/tshark/`。安装包与应用源码不包含密钥材料。

