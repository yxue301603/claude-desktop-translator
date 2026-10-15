# Claude Desktop Translator

在 **Claude 桌面应用的 Code 标签页**中输入中文，实际发给模型的用户文字自动翻译为英文；模型回答中的英文自动翻译为简体中文并显示在原会话里。

实现由一个零依赖 Node.js 本地翻译网关、启动器，以及可选的 Claude Code 原生辅助插件组成。**需要桌面版支持的第三方推理 / Gateway 配置和 API 凭据**，不能直接挂到 Claude Pro/Max 订阅会话。原生插件负责启动网关，单独安装插件不会改变输入框或回答。

```text
Code 标签页输入中文
  → 127.0.0.1 本地网关
  → 中译英 → 现有模型 API
  → 英译中 → 原 Code 会话显示中文
```

## 已验证的行为

- 中文用户文字在主模型请求发送前译为英文，翻译失败时返回错误。
- 普通 JSON 响应和 SSE 流式响应中的回答文字译为中文。
- 行内代码、围栏代码块、URL 和常见路径用占位符保护后逐字还原。
- 工具调用参数、工具结果、图片、文档附件、思考块与签名直接透传。
- JSON 对象/数组和显式请求的结构化回答直接透传，避免破坏机器协议。
- 创建单独的桌面翻译配置，保留原配置及原 API 密钥，可切换恢复。
- 仅监听 IPv4 回环地址，要求本地随机密钥，拒绝网页 Origin；日志仅记录事件与计数。

2026-10-15 已在 Windows、Claude Desktop 2.37337.1 / 内置 Claude Code 2.1.275 上用现有 DeepSeek `deepseek-flash` 接口实测：中文输入、中文回答、读取 `package.json` 工具、多轮会话、代码块及行内命令均正常。普通 / 流式 API 的真实验收脚本会断言上游收到的提示为英文。其他系统有网关单元测试；macOS / Linux 桌面操作尚未实机验证。

## 安装与启动

安装 Node.js 22 或更新版本，以及已配置 Gateway 的 Claude 桌面版。无需 `npm install`。

```powershell
git clone https://github.com/yxue301603/claude-desktop-translator.git
cd claude-desktop-translator
node bin/translator.mjs setup
node bin/translator.mjs doctor
node bin/translator.mjs start
```

通过 **File → Exit** 完全退出 Claude 桌面应用，然后执行 `node bin/translator.mjs activate-desktop` 并双击 **`启动翻译.cmd`**。后续每次使用此启动器，网关会先启动，再打开 Claude。进入 **Code → Local**，选择项目并正常输入中文即可，不需要斜杠命令。

`setup` 优先读取当前桌面 Gateway 配置，API 密钥按原文件路径引用；找不到桌面配置时，尝试读取 `~/.claude/settings.json` 的 API 配置。默认把本地配置与日志存到 `~/.claude-desktop-translator/`。不会把 API 密钥写入源码仓库。

桌面模型路由名称沿用原配置，网关展示的模型名称标明实际 `upstreamModel`，不会把模型别名当作实际模型身份。可用性仍由上游服务和桌面版的模型支持规则决定。

若桌面原先使用网关模型别名，可指定实际模型：

```powershell
node bin/translator.mjs setup --upstream-model deepseek-flash
```

如果没有现有 Gateway，请先在 Claude 的 **Help → Troubleshooting → Enable Developer Mode → Developer → Configure Third-Party Inference** 配置自己的 API 网关，再执行上述步骤。托管设备上的组织策略优先于本地设置。

## 可选：安装原生辅助插件

在 Claude Code 中运行：

```text
/plugin marketplace add yxue301603/claude-desktop-translator
/plugin install claude-desktop-translator@claude-desktop-translator
```

或使用命令行：

```powershell
claude plugin marketplace add yxue301603/claude-desktop-translator
claude plugin install claude-desktop-translator@claude-desktop-translator
```

新会话的 `SessionStart` 会检查并启动已配置的网关；`/claude-desktop-translator:translator-status` 可查看状态。桌面启动时就需要网关，所以仍建议使用启动器。

## 状态、停止与恢复

```powershell
node bin/translator.mjs status
node bin/translator.mjs stop
node bin/translator.mjs restore-desktop
```

`stop` 在有活动请求时拒绝停止。`restore-desktop` 重新选择原来的推理配置，不删除任何原配置；完全退出并重开 Claude 后生效。恢复原配置后再停止网关。

若只是关闭窗口，Claude 可能还在托盘运行；使用应用菜单 **File → Exit** 完全退出。遇到端口占用时先检查 `status`，不要终止其他不相关程序。

## 手动配置

把 `config.example.json` 复制到仓库外的私有目录，生成随机 `gatewayToken`，配置自己的上游和翻译模型，然后通过环境变量 `CDT_UPSTREAM_API_KEY` 提供 API 密钥。可用 `CDT_TRANSLATION_API_KEY` 和配置项 `translationBaseUrl` 单独指定翻译服务。

```powershell
node bin/translator.mjs serve --config C:\private\translator-config.json
```

在桌面版第三方推理界面选择 Gateway，地址为 `http://127.0.0.1:19876`，凭据为本地 `gatewayToken`，模型选择上游支持的名称。所有命令支持 `--config PATH`；如果原生插件需要使用自定义路径，请为运行 Claude 的用户设置 `CDT_CONFIG` 环境变量。

## 设计限制

- 网关按完整文本块翻译 SSE 回答，避免把代码围栏和句子切坏。因此中文按文本块出现，而非逐 token 出现；等待时仍转发工具和思考事件。
- 翻译会产生额外的 API 调用和费用，默认使用同一个已配置服务。中文输入、英文输出会交给该服务翻译。
- 系统提示、项目文件内容、工具结果和代码中的中文保持原样。翻译范围是用户正文与回答正文；这不是对所有上下文逐字转换。
- 显示后的中文回答会保存在桌面会话记录中。后续轮次的历史回答沿用这份中文记录。
- 模型可能误译自然语言。保护后的代码必须原样返回，否则请求报错；普通文字仍应人工核对。
- 自动配置以已有的 **Gateway + 静态 API 密钥**配置为基础；Bedrock、Vertex 等原生签名认证配置不在自动导入范围内。

## 验证与开发

```powershell
node --test
node scripts/live-smoke.mjs
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
```

`node --test` 不使用真实 API 密钥，覆盖真实 HTTP 网关、SSE 任意分块、工具参数和思考签名保留、代码字面量、失败处理、结构化输出和桌面配置恢复。`live-smoke.mjs` 使用本地凭据调用真实 API，结果写到被 Git 忽略的 `.local/`。

官方接口参考：[桌面 Gateway 配置](https://code.claude.com/docs/en/llm-gateway-connect#desktop-app)、[桌面插件](https://code.claude.com/docs/en/desktop#install-plugins)、[Hooks](https://code.claude.com/docs/en/hooks)。

MIT License。本项目与 Anthropic 无隶属关系。
