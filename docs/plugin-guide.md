# Claude 插件版使用说明

0.4.0 提供可安装的 `.mcpb` 桌面扩展。安装包包含运行代码、Windows 伴随窗口和生产依赖，不包含模型权重、本机配置、登录凭据或开发工具。

## 安装和启动

1. 下载 GitHub Releases 中的 `claude-desktop-translator-0.4.0.mcpb`。
2. 打开 Claude Desktop → Settings → Extensions → Advanced settings → Install Extension，选择安装包；也可以双击安装包。
3. 保持“使用离线预翻译”和“仅启用 MCP 工具”两个可选开关均关闭，即为默认的 `account` 模式，并自动打开翻译窗口。该模式不要求安装 Node.js、Ollama 或模型；Node.js 运行时由 Claude Desktop 提供。
4. 安装并启用后会显示 `Claude 中英翻译 · 账号双语 · v0.4.0` 窗口。中文写在该窗口，Enter 发送，Shift+Enter 换行。

关闭翻译窗口后，可以在 Claude 中调用扩展的 `open_translation_window` 工具重新打开。扩展也提供 `bilingual_request` 提示模板，可直接在支持 MCP prompts 的界面中使用，不需要伴随窗口和模型。普通 Chat 的扩展功能是否可见取决于 Claude 版本、账号权限和组织策略；本项目不会改变这些权限。

安装过程仍需在 Claude 中确认其本地权限。此扩展没有修改 Claude 源码或原始聊天界面。伴随窗口使用 Windows 辅助功能，需要 Claude 暴露可访问的输入框；未暴露时，通过项目启动器打开 Claude（带 `--force-renderer-accessibility`）后重试。

## 两种模式的区别

| 模式 | 输入如何处理 | 中文回答来源 | 本地模型 |
|---|---|---|---|
| `account`（默认） | 提交英文流程指令和中文原文，Claude 先生成英文理解，再回答 | 同一次官方回答中的完整中文段落 | 不需要 |
| `offline` | 本机先将中文译成英文，校验后只提交英文结果 | 本地模型回译 Claude 的回答 | 需要 Ollama 和 Hy-MT2 |

**账号模式并不承诺“Claude 收到的只有英文”。中文原文也会发送。** 它使用当前 Claude 官方账号，不要求 Claude Code、API Key 或第三方 Gateway。英文理解、英文回答、中文回答会出现在同一条 Claude 消息中，伴随窗口只提取完整中文段落；任一段落或结束标记缺失时会等待或报错，不截取第一句交付。

该模式只自动处理由本工具或 `bilingual_request` 模板发起的带分隔标记的双语回答。普通历史英语回答没有中文段落，不能凭空回译；需要时切换为 `offline`。账号模式消耗现有 Claude 对话额度，并会增加双语输出长度。Claude 拒绝请求或未遵守输出格式时，原回答仍留在 Claude；可以在 Claude 中重试。

如必须在 Claude 接收前完成英文预翻译，保留 `offline` 模式。先按 README 安装 Ollama 和模型，再在扩展设置中打开“使用离线预翻译”并重新启用扩展。无须删除已经下载的模型。

## 启停与数据

启用扩展会启动 MCP 进程，默认打开翻译窗口；不自动发送消息。停用时 Claude 可能一并结束其子窗口，因此未发送输入会实时用当前 Windows 用户的 DPAPI 加密保存在本机 `companion-draft.bin`，下次打开窗口自动恢复；发送成功或清空输入后删除加密草稿。正常日志不保存原文。单独由旧版启动器打开的窗口不归扩展生命周期管理。

扩展在 Claude 内置运行时中直接提供回环服务，不把 Claude 可执行文件当作独立 Node 启动子服务；退出扩展会关闭它自己创建的服务。已经由独立启动器启动的共享服务保留供复用，可用 `npm run stop` 停止。扩展不会终止用户已有的 Ollama 进程。

扩展本地服务仅监听 `127.0.0.1:19877`，使用随机本机令牌，拒绝网页 Origin。账号模式的准备与提取操作只处理字符串，不发出模型网络请求；真正的对话由 Claude 官方桌面程序使用自己的登录会话发送。没有读取、导出或直接复用 Claude 的 OAuth 凭据。

为避免覆盖已有内容，如果 Claude 输入框中还有草稿而伴随窗口也写了新输入，会停止发送。Windows 锁屏时不绕过焦点校验、不解锁、不发送；熄屏本身不一定影响辅助功能，最终以实际焦点校验为准。

## 开发与构建

```powershell
npm ci
npm test
npm run build:extension
npm run verify:extension
```

安装包和 SHA-256 校验文件输出到 `artifacts/`。构建只复制白名单目录，在独立暂存目录中用 `npm ci --omit=dev --ignore-scripts` 安装生产依赖，再由官方 MCPB 工具验证清单并打包。包内测试从解压目录启动真实 stdio MCP 进程，防止误用源码目录依赖。

参考：[Claude 官方扩展安装](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)、[MCPB 规范](https://github.com/modelcontextprotocol/mcpb)。普通 Chat 不支持插件 Hooks，参见[官方插件能力说明](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)。
