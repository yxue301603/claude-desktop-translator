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

需要 Windows、Node.js 22+、Windows PowerShell 5.1 和已安装的 Claude 桌面版。普通 Chat 可以使用当前账号可用的权限；本工具不改变账号套餐或额度。

```powershell
git clone https://github.com/yxue301603/claude-desktop-translator.git
cd claude-desktop-translator
npm ci
npm run setup
npm run models
```

`models` 首次下载两个中英翻译模型，合计数百 MB。后续翻译在本地 CPU 上进行，运行时禁止加载远端模型。模型缓存位于 `~/.claude-desktop-translator/offline-models/`。

如果下载需要本机现有代理，在 Node.js 24 中可先设置以下环境变量，再运行 `npm run models`。地址请填写自己正在使用的代理：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:YOUR_PROXY_PORT'
$env:HTTP_PROXY = $env:HTTPS_PROXY
$env:NODE_USE_ENV_PROXY = '1'
npm run models
```

如果之前启用了第三方推理，`setup` 会备份桌面配置并切回官方账号模式。请通过 Claude 的 **File → Exit** 完全退出，然后双击 **`启动翻译.cmd`**。

## 使用

1. 在 Claude 桌面版打开普通 Chat，登录自己的账号。
2. 在“Claude 中英翻译 · 离线”窗口输入中文。Enter 发送，Shift+Enter 换行。
3. 插件会显示实际提交的英文，并填入 Claude 输入框、校验内容后发送。
4. 回答结束后，中文译文自动显示在插件窗口。关闭“自动读取”可暂停读取回答。

也可以在 Claude 输入框先写中文，再点击伴随窗口的“翻译并发送给 Claude”；这种情况下请保持伴随窗口自己的输入区为空。在伴随窗口写了文字时，如果 Claude 输入框还有其他草稿，插件会停止发送，避免覆盖草稿。

请保持 Windows 解锁且 Claude 窗口可交互。焦点校验失败时不会提交，中文输入会保留。

## 翻译与代码

- 采用 `Xenova/opus-mt-zh-en` 与 `Xenova/opus-mt-en-zh` 的量化 ONNX 模型，使用 Transformers.js 和本地 CPU 推理。
- 输入中的行内代码、围栏代码、URL、常见路径被分开保护，不交给翻译模型。
- 回答通过辅助功能的文本与等宽字体识别代码，给代码内容加保护后再翻译。辅助功能不提供完整 Markdown，复杂表格、代码缩进或其他格式可能与原界面不同；完整原文始终保留在 Claude。
- 译文在回答结束后显示。它不改写 Claude 的历史记录，也不改变后续对话上下文。
- 小型离线翻译模型可能误译复杂指令或技术术语，发送前后的英文预览和 Claude 原文可用于核对。

## 数据与权限

主对话完全由 Claude 官方桌面客户端使用当前账号发送。本工具不读取 Claude 登录凭据，不转发主模型请求，不使用第三方翻译服务。

运行时只有一个绑定 `127.0.0.1:19877` 的本地翻译进程。伴随窗口通过随机本地令牌与它通信；该进程只提供翻译操作，没有模型 API 代理接口，并拒绝网页 Origin。正常日志不保存输入、回答或译文。

桌面集成只通过 Windows 辅助功能读取 Claude 窗口，在用户点击发送或在工具自己的输入区按 Enter 后填入英文。没有全局键鼠监听，也不使用剪贴板。中文输出在伴随窗口中显示，Claude 原界面保留原文。

## 状态与停止

```powershell
npm run status
npm run stop
```

关闭伴随窗口后可用 `stop` 释放模型内存；存在活动翻译时服务会拒绝停止。配置位于 `~/.claude-desktop-translator/offline.json`，它只保存本地端口和本地随机令牌。

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
powershell -NoProfile -STA -ExecutionPolicy Bypass -File windows/start-bridge.ps1 -Config unused -CompileOnly
```

`doctor` 在禁止所有 `fetch` 网络调用的条件下运行真实本地模型，检查中英翻译与代码保护。普通测试使用模拟模型，覆盖代码分段、长度限制、串行推理、失败恢复、本地请求鉴权及账号模式配置备份。

界面集成针对 Windows Claude Desktop 2.37337.1 的普通 Chat 开发。macOS / Linux 尚不支持伴随窗口；Claude 界面结构变化时可能需要更新辅助功能定位。

模型来源：[中译英模型](https://huggingface.co/Xenova/opus-mt-zh-en)、[英译中模型](https://huggingface.co/Xenova/opus-mt-en-zh)、[Transformers.js](https://huggingface.co/docs/transformers.js/)。模型权重由各自作者按其许可证发布，不随源码分发。

MIT License。本项目与 Anthropic 无隶属关系。
