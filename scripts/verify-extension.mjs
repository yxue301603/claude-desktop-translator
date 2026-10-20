import { readFile, writeFile, mkdtemp, readdir, access } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
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
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await writeFile(path.join(profile, 'offline.json'), JSON.stringify({ schemaVersion: 2, port, token: randomBytes(32).toString('hex'), mode: 'api' }));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(output, 'bin/extension.mjs')], cwd: output, env: { ...process.env, CDT_STATE_DIRECTORY: profile, CDT_AUTO_START: 'false', CDT_TRANSLATION_MODE: 'api', CDT_TRANSLATION_API_KEY: '' }, stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 3);
  assert.ok(!tools.tools.some(tool => /bilingual/.test(tool.name)));
  const prompts = await client.listPrompts(); assert.equal(prompts.prompts[0].name, 'english_request');
  const result = await client.callTool({ name: 'translator_status', arguments: {} });
  assert.equal(result.structuredContent.localModelRequired, false);
  assert.equal(result.structuredContent.englishOnly, true);
  const prepared = await client.callTool({ name: 'prepare_english_request', arguments: { text: 'Explain this code without executing it.' } });
  assert.notEqual(prepared.isError, true, 'Isolated packaged service must prepare English while the desktop service is running');
  assert.equal(prepared.structuredContent.text, 'Explain this code without executing it.');
  const rejected = await client.callTool({ name: 'prepare_english_request', arguments: { text: '你好' } }); assert.equal(rejected.isError, true);
  console.log(JSON.stringify({ archive, bytes: bytes.length, sha256: digest, packagedStdio: true, toolCount: tools.tools.length, englishOnly: true, rejectsMissingKeyWithoutSourceFallback: true, noLocalModelRequired: true, noPrivateFilesOrDevTools: true }, null, 2));
} finally { await client.close(); }
