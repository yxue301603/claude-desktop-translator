import { readFile, mkdtemp, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { unpackExtension } from '@anthropic-ai/mcpb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { root, version } from '../src/desktop-controller.mjs';

const archive = path.join(root, 'artifacts', `claude-desktop-translator-${version}.mcpb`);
const bytes = await readFile(archive);
const digest = createHash('sha256').update(bytes).digest('hex');
assert.ok((await readFile(path.join(root, 'artifacts/SHA256SUMS.txt'), 'utf8')).startsWith(digest));
const output = await mkdtemp(path.join(root, 'artifacts/mcpb-verify-'));
assert.equal(await unpackExtension({ mcpbPath: archive, outputDir: output, silent: true }), true);
const files = await readdir(output);
const allowed = ['manifest.json', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'src', 'bin', 'windows', 'docs', 'node_modules', '.mcpbignore'];
assert.ok(files.every(file => allowed.includes(file)), 'Unexpected top-level package file');
for (const excluded of ['.local', '.git', 'offline.json', 'node_modules/@anthropic-ai/mcpb', 'node_modules/node-forge'])
  await assert.rejects(access(path.join(output, excluded)), undefined, excluded + ' must not be bundled');
const client = new Client({ name: 'packaged-extension-verification', version: '1' });
const profile = await mkdtemp(path.join(root, 'artifacts/mcpb-profile-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(output, 'bin/extension.mjs')], cwd: output, env: { ...process.env, CDT_STATE_DIRECTORY: profile, CDT_AUTO_START: 'false', CDT_TRANSLATION_MODE: 'account' }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 5);
  const prompt = await client.getPrompt({ name: 'bilingual_request', arguments: { text: '请保留 `npm test`，完整回答，不要执行。' } });
  assert.ok(prompt.messages[0].content.text.includes('请保留 `npm test`'));
  const result = await client.callTool({ name: 'translator_status', arguments: {} });
  assert.equal(result.structuredContent.localModelRequired, false);
  console.log(JSON.stringify({ archive, bytes: bytes.length, sha256: digest, packagedStdio: true, toolCount: tools.tools.length, noLocalModelRequired: true, noPrivateFilesOrDevTools: true }, null, 2));
} finally { await client.close(); }
