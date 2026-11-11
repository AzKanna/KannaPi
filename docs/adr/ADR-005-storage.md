# ADR-005：存储 = SQLite(WAL) + 内容寻址正文 + Pi 原生 JSONL 会话；SQLite 驱动 = node:sqlite

状态：已接受（2026-09-07）· 修订：better-sqlite3 → node:sqlite

## 决策
- 单库 `data/kanna.db`（SQLite WAL）：flows / actions / findings / hypotheses / tests / audit / scopes / blobs 表。
- **正文内容寻址**：请求/响应 body 按 sha256 去重存 blob 表，flow 行只存 `BodyRef{blobHash, size, mimeType, encoding, truncated, textPreview}`——工具默认返回元数据，正文按需取且预算截断（token 预算核心，burpwn 验证的模型）。
- 会话持久化用 Pi 原生 JSONL 树（SessionManager 指向 app 数据目录），不重复造轮子。
- 无向量数据库、无 ORM：手写 migration（版本表+SQL 文件）+ 薄 repo 层。
- **驱动：Node 24 内置 `node:sqlite`**（DatabaseSync，同步 API，实验性标志）。

## 修订原因（better-sqlite3 → node:sqlite）
开发机无 VS C++ 构建工具，better-sqlite3 v13 预编译二进制下载失败后回退源码编译失败（node-gyp 找不到 VS）。实测 `node:sqlite`：DatabaseSync 可用、**内置 FTS5**（traffic_search 后备）、零原生依赖——对毕设环境复现性反而更优。实验性告警经 `--disable-warning=ExperimentalWarning` 抑制。

## 后果
+ 零原生依赖（Windows 无构建工具可完整跑通）；FTS5 内置；WAL 支持读并发。
− node:sqlite API 较 better-sqlite3 精简（无 .transaction() 语法糖等）——repo 层自行封装；Node 24+ 强依赖（engines 已声明）。
