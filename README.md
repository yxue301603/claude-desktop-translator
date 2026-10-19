# Claude Desktop Translator · 插件版

为 Windows Claude Desktop 提供中英双语工作流，发布格式为 **`.mcpb` 桌面扩展**。安装后由 Claude 启动翻译伴随窗口，继续使用自己的官方账号，无需第三方 Gateway 或翻译 API。

**默认账号双语模式不需要 Ollama 或本地模型。** 它将英文流程指令和中文原文一起提交给 Claude，由 Claude 依次生成英文理解、英文回答和完整中文译文，再将中文显示在伴随窗口。它不会假称“发送前已经将中文全部翻成英文”。

如果必须先在本机翻译、只向 Claude 提交英文，可选择保留的 `offline` 模式。

## 安装插件

1. 从 [Releases](https://github.com/yxue301603/claude-desktop-translator/releases) 下载 `claude-desktop-translator-0.4.0.mcpb`。
2. 在 Claude Desktop → Settings → Extensions → Advanced settings → Install Extension 中选择该文件，或双击安装包。
3. 保持两个可选开关均为**关闭**，即为默认的 `account` 模式，并自动打开翻译窗口。
4. 在标题为 `Claude 中英翻译 · 账号双语 · v0.4.0` 的窗口输入中文。**Enter** 发送，**Shift+Enter** 换行。
5. Claude 完成双语回答后，伴随窗口显示完整中文。实际提交内容可在预览区核对。

账号模式无需额外安装 Node.js 或 Ollama；扩展使用 Claude Desktop 内置的 Node.js，以及 Windows PowerShell 5.1 / .NET Framework。账号权限和组织策略仍由 Claude 决定。插件保留独立伴随窗口，通过 Windows 辅助功能读取与填写，不修改 Claude 的原始界面。

详细说明、启停行为和两种模式的差异见 [插件使用说明](docs/plugin-guide.md)。

## 两种模式

| 模式 | 发给 Claude 的内容 | 中文结果 | 额外要求 |
|---|---|---|---|
| `account`（默认） | 英文流程指令 + 中文原文 | 当前 Claude 官方账号生成 | 无本地模型；使用现有聊天额度 |
| `offline` | 本地模型预翻译得到的英文 | 本地模型回译 | Ollama、Hy-MT2 权重约 1.13 GB |

账号模式只提取本工具发起的带分隔标记的回答；普通历史英文回答需要离线模式才能回译。它检查三段内容和结束标记是否完整，不把首句摘要当成全文。完整性检查不能保证所有语义都正确，Claude 原始双语回答可供核对。

## 从源码运行

```powershell
npm ci
npm start
```

也可双击 `启动翻译.cmd`。启动器默认使用已保存模式；旧配置没有模式时，默认改用账号双语模式。若 Claude 未暴露辅助功能输入框，请使用启动器打开 Claude，它会附带 `--force-renderer-accessibility`。

显式选择模式：

```powershell
node bin/offline.mjs launch account
node bin/offline.mjs launch offline
npm run status
npm run stop
```

## 离线模式的额外安装

安装 [Ollama](https://ollama.com/download/windows)，再运行：

```powershell
npm run models
node bin/offline.mjs launch offline
```

模型为腾讯 `Hy-MT2-1.8B-GGUF:Q4_K_M`，通过 `127.0.0.1:11434` 推理。首次下载与翻译推理分开，运行时不下载权重、不使用云端模型。也支持导入官方 GGUF 文件，安装脚本校验 SHA-256：

```powershell
node scripts/download-models.mjs --gguf C:\Models\Hy-MT2-1.8B-Q4_K_M.gguf
```

离线翻译保护代码、路径和 URL，在完整段落内翻译；长文按完整句子或段落分批并提供上一批上下文。模型遗漏、重复、换序占位符或输出截断时拒绝部分结果。真实样例及限制见 [离线翻译质量报告](docs/translation-quality.md)。

## 数据和桌面权限

主对话由 Claude 官方桌面程序使用当前登录账号发送。本扩展不读取登录凭据、不复用 OAuth 令牌、不代理主模型请求，不使用第三方翻译服务。

伴随窗口连接仅监听 `127.0.0.1:19877` 的本地服务，使用随机本机令牌并拒绝网页 Origin。账号模式的请求准备与中文提取只处理字符串，不发出模型请求。离线模式只向本机 Ollama 发送推理请求。配置保存在 `~/.claude-desktop-translator/offline.json`；正常日志不保存原文、回答或译文。

发送只在你点击按钮或在伴随窗口按 Enter 后发生，没有全局键鼠监听。为保留多行与代码，会临时使用剪贴板粘贴并在内容校验后恢复；若你在此期间进行了新的复制，则保留新复制内容。系统剪贴板历史与同步仍按系统设置工作。输入框已有其他草稿时会停止发送，防止覆盖；锁屏时不绕过焦点校验。

未发送输入会用当前 Windows 用户的 DPAPI 加密保存，扩展停用或窗口意外退出后可恢复；发送成功或清空输入后删除。这是本机草稿恢复文件，不会打入安装包或上传 GitHub。

## 构建与测试

```powershell
npm ci
npm test
npm run build:extension
npm run verify:extension
powershell -NoProfile -STA -ExecutionPolicy Bypass -File test/windows/test-bridge.ps1
```

构建输出 `artifacts/*.mcpb` 与 `SHA256SUMS.txt`，仅包含白名单源码和生产依赖。包内协议测试从独立解压目录启动真实 MCP stdio 进程，检查工具、提示模板、配置隔离和私有文件排除。Windows 测试另覆盖正文提取、首句摘要排除、生成等待、正文增长及重试。

可选离线模型测试：`npm run doctor`、`npm run accuracy`。准确性脚本生成真实译文供逐项核对，不把脚本运行成功当成语义准确率 100%。

交付与实机范围见 [验收记录](docs/verification.md)，安装与明早验收步骤见 [插件使用说明](docs/plugin-guide.md)。

## 升级

从 0.3.x 升级：关闭旧伴随窗口，更新源码或安装新的 `.mcpb`，默认选择 `account` 即可绕开 Ollama 启动和模型下载。已有模型不删除，可以随时选回 `offline`。

若曾使用 0.1.0 的 Code Gateway 插件，请先禁用卸载旧插件，再使用新版本。旧实现仅保留在 Git 历史中；当前扩展无 Gateway 逻辑。

[模型来源](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF) · [MCPB 官方规范](https://github.com/modelcontextprotocol/mcpb) · [Claude 扩展安装说明](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

MIT License。本项目与 Anthropic 无隶属关系，模型权重不随源码或扩展分发。
