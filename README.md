# Claude Desktop Translator · 离线版

在 Windows 上为 **整个 Claude 桌面应用**提供中英翻译，支持普通 Chat；使用 Claude 中已经登录的官方账号，不需要 Claude API Key、Gateway 或第三方翻译 API。

这是一个**伴随窗口形式的桌面增强工具**，不是 Code 标签页的原生插件，也不是 MCP / DXT 扩展。中文写在伴随窗口中，点击发送或按 Enter 后，本地模型翻译成英文，再填入 Claude 官方输入框并发送。Claude 回答保持在原窗口，中文译文自动显示在伴随窗口。

```text
伴随窗口输入中文 → 本机离线模型 → 英文填入 Claude 官方输入框
                                         ↓
                                已登录的 Claude 官方账号
                                         ↓
中文译文显示在伴随窗口 ← 本机离线模型 ← 只读辅助功能读取回答
```

## 安装

需要 Windows、Node.js 22+、Windows PowerShell 5.1、[Ollama](https://ollama.com/download/windows) 和已安装的 Claude 桌面版。普通 Chat 可以使用当前账号可用的权限；本工具不改变账号套餐或额度。本机已安装并启动 Ollama 时，启动器直接复用它。

```powershell
git clone https://github.com/yxue301603/claude-desktop-translator.git
cd claude-desktop-translator
npm ci
npm run setup
npm run models
```

`models` 首次下载腾讯 `Hy-MT2-1.8B` 的 Q4_K_M 专用翻译模型，权重约 **1.13 GB**，两个方向使用同一个模型。权重保存在 Ollama 的本机模型目录，默认是 `~/.ollama/models/`。翻译进程只访问回环地址 `127.0.0.1:11434`，不下载模型、不调用云端模型，也不使用 Ollama 云服务。

如果下载需要代理，请给 **Ollama 进程**配置其官方支持的网络代理后重启 Ollama，再运行 `npm run models`。也可以从官方模型仓库取得 `Hy-MT2-1.8B-Q4_K_M.gguf` 后导入；安装脚本会核对已验证权重的 SHA-256：

```powershell
node scripts/download-models.mjs --gguf C:\Models\Hy-MT2-1.8B-Q4_K_M.gguf
```

如果之前启用了第三方推理，`setup` 会备份桌面配置并切回官方账号模式。请通过 Claude 的 **File → Exit** 完全退出，然后双击 **`启动翻译.cmd`**。

## 使用

1. 在 Claude 桌面版打开普通 Chat，登录自己的账号。
2. 在“Claude 中英翻译 · 离线”窗口输入中文。Enter 发送，Shift+Enter 换行。
3. 插件会显示实际提交的英文，并填入 Claude 输入框、校验内容后发送。
4. 回答结束后，中文译文自动显示在插件窗口。关闭“自动读取”可暂停读取回答。

窗口标题显示当前版本（例如 `v0.3.1`）。0.3.1 修复了只翻译首句的问题：读取消息正文，不再把辅助功能的首句摘要当成整篇回答；正文停止变化后再翻译，后续正文发生变化时会重新翻译。

也可以在 Claude 输入框先写中文，再点击伴随窗口的“翻译并发送给 Claude”；这种情况下请保持伴随窗口自己的输入区为空。在伴随窗口写了文字时，如果 Claude 输入框还有其他草稿，插件会停止发送，避免覆盖草稿。

请保持 Windows 解锁且 Claude 窗口可交互。焦点校验失败时不会提交，中文输入会保留。

## 翻译与代码

- 采用腾讯 `Hy-MT2-1.8B-GGUF:Q4_K_M`，通过本机 Ollama 推理；没有第三方翻译 API。
- 代码、URL 和路径替换为占位符，但它们两侧的文字仍在**同一个完整段落**里翻译，再逐字还原原始代码，不再分别翻译半句话。
- 短文的相邻段落一起翻译，保留跨段指代。长文按完整段落或完整句子分批，并提供上一批的源文作为上下文；不会为了长度限制从词语或句子中间截断。单句超过上限时会报错并保留原文。
- 占位符丢失、重复、换序或模型输出截断时，整次翻译失败，不提交部分译文。该完整性检查不能替代语义核对。
- 回答通过辅助功能的文本与等宽字体识别代码，给代码内容加保护后再翻译。辅助功能不提供完整 Markdown，复杂表格、代码缩进或其他格式可能与原界面不同；完整原文始终保留在 Claude。
- 译文在回答结束后显示。它不改写 Claude 的历史记录，也不改变后续对话上下文。
- 小型离线翻译模型仍可能误译复杂指令或技术术语，英文预览和 Claude 原文可用于核对。真实双向样例及逐条语义检查见[翻译质量报告](docs/translation-quality.md)。

## 数据与权限

主对话完全由 Claude 官方桌面客户端使用当前账号发送。本工具不读取 Claude 登录凭据，不转发主模型请求，不使用第三方翻译服务。

伴随窗口通过随机本地令牌连接 `127.0.0.1:19877` 的本地翻译进程；该进程只向 `127.0.0.1:11434` 的本机 Ollama 发出已安装模型的推理请求。翻译接口没有主模型代理功能，并拒绝网页 Origin。正常日志不保存输入、回答或译文。

桌面集成只通过 Windows 辅助功能读取 Claude 窗口，在用户点击发送或在工具自己的输入区按 Enter 后填入英文。没有全局键鼠监听。为保留多行与 Markdown，发送时会临时把英文放入系统剪贴板并粘贴；校验草稿后恢复先前的剪贴板内容。如果期间用户进行了新的复制操作，则保留用户新复制的内容。系统若启用了剪贴板历史或同步，会按其设置处理这次临时复制。中文输出在伴随窗口中显示，Claude 原界面保留原文。

## 状态与停止

```powershell
npm run status
npm run stop
```

关闭伴随窗口后可用 `stop` 停止翻译进程并卸载本工具使用的模型；存在活动翻译时服务会拒绝停止。模型也会在空闲约一分钟后自动卸载。配置位于 `~/.claude-desktop-translator/offline.json`，它只保存本地端口和本地随机令牌。

从 0.2.0 升级时，先运行 `npm run stop`，安装并启动 Ollama，执行 `npm run models`，然后重新打开启动器。旧的 OPUS-MT 缓存不再使用，不会自动删除用户文件。

从 0.3.0 升级到 0.3.1：关闭翻译伴随窗口，在项目目录运行 `git pull --ff-only`，再双击 `启动翻译.cmd`。检查标题是否显示 `v0.3.1`；无需重新下载翻译模型。

从旧版 0.1.0 升级时，先停用并卸载旧的 Code 辅助插件：

```powershell
claude plugin disable claude-desktop-translator@claude-desktop-translator
claude plugin uninstall claude-desktop-translator@claude-desktop-translator
```

旧版 Gateway 实现仅留在 Git 历史中；当前代码不包含它的运行逻辑。

## 验证

```powershell
node --test
npm run doctor
npm run accuracy
powershell -NoProfile -STA -ExecutionPolicy Bypass -File windows/start-bridge.ps1 -Config unused -CompileOnly
powershell -NoProfile -STA -ExecutionPolicy Bypass -File test/windows/test-bridge.ps1
```

`doctor` 运行真实本地模型，并检查测试进程的推理请求全部指向回环地址。`accuracy` 生成 20 条真实双向译文，包含否定、条件、跨段指代、数值、Markdown 和代码，结果写入忽略提交的 `.local/accuracy-results.json`；每条都有待核对的句意要求。脚本通过仅说明调用和代码完整性通过，**不自动把语义准确率标成通过**。普通回归测试使用模拟模型，覆盖上下文、完整性拒绝、串行推理、失败恢复、本地鉴权和账号配置备份。

Windows 回归测试另用独立辅助功能窗口验证：从原始祖先定位正文、提取多个文本节点、排除正文外推广文字，以及禁止首句摘要替代正文；同时检查生成等待、正文增长、失败重试和会话切换。它不打开 Claude，不提交消息，也不调用翻译模型。

界面集成针对 Windows Claude Desktop 2.37337.1 的普通 Chat 开发。macOS / Linux 尚不支持伴随窗口；Claude 界面结构变化时可能需要更新辅助功能定位。

实机发送、回译、代码与剪贴板恢复的验证范围见[本机验收记录](docs/verification.md)。

模型来源：[腾讯 Hy-MT2-1.8B-GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF)。推理运行时：[Ollama](https://ollama.com/)。权重由其作者按模型许可证发布，不随源码分发。

MIT License。本项目与 Anthropic 无隶属关系。
