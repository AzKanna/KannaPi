# Skills 上传与 Pi Plugins

## 上传 Skill

在 **Settings → Skills** 中选定 Agent，点击上传区或把一个 `SKILL.md` 拖进去，确认后上传。文件需要有效的 Pi Skill frontmatter（至少 `name` 与 `description`）。KannaPi 把文件复制到当前应用的数据目录，并将它挂到该 Agent；不再要求用户手输绝对路径。删除上传的 Skill 时，本地副本也会删除。

这条入口只上传单个 `SKILL.md`。如果它引用同目录下的脚本、图片或参考文件，这些附件不会随文件一起上传；应改用不依赖外部文件的 Skill，或使用保留的本地路径 API 配置完整目录。已运行的会话会在能力变更后卸载，下次消息重新装载；沙箱会话仍遵循工作副本快照规则，必要时新建 Session。

## Pi Plugins

在 **Settings → Pi Plugins** 中上传一个本地 `.ts`、`.js` 或 `.mjs` 文件。文件必须默认导出 Pi `ExtensionFactory`，例如：

```js
export default (pi) => {
  pi.on("agent_start", () => {
    // 会话启动钩子
  });
  pi.registerTool({
    name: "hello_plugin",
    label: "Hello Plugin",
    description: "Return a greeting",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "Hello from Pi Plugin" }] };
    },
  });
};
```

上传时必须勾选源码信任确认。插件按 Agent 单独保存，可启用、停用或删除；删除同时清理上传的本地文件。KannaPi 只显式加载这些文件，不扫描项目或全局 Pi 扩展目录，也不会自动安装 npm/git 包。多个插件与内置工具重名时会阻止启动并显示冲突错误。

**安全边界：Plugin 是可执行宿主代码。** Pi 扩展钩子不受普通工具白名单约束，因此仅当 Agent 设为 **Full** 且 **Settings → Execution & Context** 中关闭工具沙箱时才加载。默认沙箱开启时，即使插件标为“Enabled”也不会执行。关闭沙箱会放宽隔离，只有在完全信任插件和项目时才这么做。上传的插件应尽量自包含；依赖其他文件或 npm 包的 Pi Package 安装流程目前不由本界面支持。
