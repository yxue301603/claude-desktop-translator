---
name: translator-status
description: Check the configured Claude Desktop translation gateway and report whether Chinese/English translation is active.
disable-model-invocation: true
allowed-tools: Bash(node *), PowerShell(node *)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/translator.mjs" status` and summarize the service counters in Chinese. Do not read or display configuration files, credentials, prompts, or response content. If the service is offline, tell the user to run the repository's `启动翻译.cmd` launcher.
