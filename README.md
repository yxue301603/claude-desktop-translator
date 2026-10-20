# Claude Desktop Translator · 1.0

Windows Claude Desktop 的 `.mcpb` 翻译扩展：**先在 Claude 对话之外译成英文，再提交；按消息翻译可读取的回答、思考摘要和中间输出。** 主对话继续使用自己的 Claude 官方账号。

默认使用用户提供 API Key 的翻译服务，无需本地模型。保留本地离线翻译，以及需明确开启的旧账号双语模式。英文输入不能保证避免封号；本项目不提供账号封禁规避承诺。

## 安装与配置

1. 在 [Releases](https://github.com/yxue301603/claude-desktop-translator/releases/tag/v1.0.0) 下载 `claude-desktop-translator-1.0.0.mcpb`。
2. Claude → Settings → Extensions → Advanced settings → Install Extension，选择安装包。
3. 在扩展设置填写**翻译 API Key**、API 基础地址和模型。Key 标为敏感字段，只用于所选翻译服务，不是 Claude 桌面登录令牌。
4. 默认地址为 `https://api.deepseek.com`，模型为 `deepseek-flash`。可改用兼容 Chat Completions 的 HTTPS 服务，如 `https://服务商/v1`；使用服务商自己的 Key 和模型名称。[DeepSeek 官方协议](https://api-docs.deepseek.com/)
5. 默认保持“使用本地离线翻译”“允许发送中文：使用旧账号双语模式”关闭。启用后出现 `Claude 中英翻译 · API 英文提交 · v1.0.0`。
6. 在伴随窗口输入中文，Enter 翻译并发送，Shift+Enter 换行。实际英文在预览区显示。

不需要另装 Node.js；扩展使用 Claude Desktop 内置运行时和 Windows PowerShell 5.1。API Key 的额度、计费和数据处理由所选服务商决定。

## 默认不会把原始中文提交给 Claude

API / offline 模式都调用英文准备接口，再进行两层中文字符检查和输入框逐字校验。翻译失败、缺少 Key、输出截断、保护内容或数值被改写时停止发送，保留原文；**不会回退到把中文交给 Claude 翻译**。

代码、命令、URL 和路径原样保护。如果这些内容本来含有中文，也会拦截，不会为了通过检查偷偷改写代码或文件名。已有英文无需翻译，可直接准备提交。

此约束针对伴随窗口及本扩展提供的英文准备工具。用户直接在 Claude 原生输入框、附件或其他插件中输入的内容，本扩展无法全局拦截。默认 MCP 工具不返回中文译文给 Claude，中文输出只显示在伴随窗口。

## 逐条输出与思考

伴随窗口按“消息 → 思考 / 中间输出 / 回答”显示译文。读取辅助功能暴露的助手消息，不再只处理最后一条最终回答。各区块独立等待稳定、去重、翻译和重试；回答仍在生成时，已经稳定的公开思考可以先翻译。正文增长后重新翻译完整区块，切换聊天后丢弃过期结果。

**仅处理 Claude 已显示并通过辅助功能暴露的文本。** 请自行展开思考区域，再点击伴随窗口“刷新”；插件不自动展开、不点击工具、不滚动你的聊天、不解锁屏幕。折叠且未暴露的内容、服务端内部思考、图像和未加载的历史文本无法读取或还原。公开的思考摘要与模型完整内部思考并不等同。

API 模式会把这些待译文本发送给你配置的服务商，按区块产生翻译请求和费用；成功结果会缓存，失败后暂停 30 秒，可点刷新立即重试。暂停自动翻译可以关闭窗口内的勾选项。

## 三种模式

| 模式 | 交给 Claude 的输入 | 输出中译 | 要求 |
|---|---|---|---|
| `api`（默认） | 校验后的英文，拒绝中文残留 | 翻译 API；含可读取思考和中间文本 | 用户自己的翻译 API Key |
| `offline` | 本地预翻译并校验的英文 | 本地模型；相同区块读取逻辑 | Ollama、Hy-MT2 约 1.13 GB |
| `account`（旧模式，明确选择） | **含中文原文**的双语工作流 | 只提取带标记回答中的中文，不能独立回译思考 | 当前 Claude 账号 |

离线和旧账号双语模式不能同时开启。从 0.4 升级时，旧版默认 account 配置迁移为 api；不会自动继续发送中文。没有 API Key 时停止中文预翻译，或自行选择离线模式。

## 源码运行和离线模型

```powershell
npm ci
$env:CDT_TRANSLATION_API_KEY = '你的翻译服务 Key'
$env:CDT_TRANSLATION_BASE_URL = 'https://api.deepseek.com'
$env:CDT_TRANSLATION_MODEL = 'deepseek-flash'
npm start
```

不要提交真实 Key 到仓库，也不要把 Key 写进命令截图。环境变量只在当前进程及其服务中使用；伴随窗口子进程不会继承翻译 Key。

```powershell
# 离线模式：先安装 Ollama，再下载一次模型
npm run models
node bin/offline.mjs launch offline

# 显式模式选择
node bin/offline.mjs launch api
node bin/offline.mjs launch account
npm run status
npm run stop
```

API Key 不写入本扩展的 `offline.json`，只通过 Claude 的敏感配置环境变量进入翻译服务。已有模型不删除。离线质量历史记录见 [翻译质量报告](docs/translation-quality.md)。

## 测试和构建

```powershell
npm ci
npm test
powershell -NoProfile -STA -ExecutionPolicy Bypass -File test/windows/test-bridge.ps1
npm run build:extension
npm run verify:extension
```

Windows 测试使用不激活、位于屏幕外的辅助功能样例窗口，不向真实 Claude 发送消息。包内测试使用独立配置和真实 MCP stdio。安装包仅包含白名单源码及生产依赖，没有 API Key、草稿、模型或本机日志。

[1.0 验收记录与范围](docs/verification-1.0.md) · [使用说明](docs/plugin-guide.md) · [数据处理说明](docs/privacy.md) · [历史验收](docs/verification.md)

MIT License。本项目与 Anthropic 无隶属关系。
