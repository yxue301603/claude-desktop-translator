import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createExtensionServer } from '../src/extension-server.mjs';

test('real stdio extension initializes with a temporary profile, no GUI, no Ollama and no secrets on stdout', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'cdt-mcp-'));
  const client = new Client({ name: 'translator-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/extension.mjs', import.meta.url))], env: { ...process.env, CDT_STATE_DIRECTORY: folder, CDT_AUTO_START: 'false', CDT_TRANSLATION_MODE: 'account' }, stderr: 'pipe' });
  t.after(async () => { await client.close(); await rm(folder, { recursive: true, force: true }); });
  await client.connect(transport);
  const list = await client.listTools(); assert.equal(list.tools.length, 4);
  const status = await client.callTool({ name: 'translator_status', arguments: {} });
  assert.equal(status.structuredContent.localModelRequired, false);
  assert.ok(!JSON.stringify(status).includes('token'));
  const prepared = await client.callTool({ name: 'prepare_bilingual_request', arguments: { text: '请完整解释代码，不要执行。' } });
  assert.ok(prepared.structuredContent.text.includes('请完整解释代码，不要执行。'));
  assert.equal((await client.callTool({ name: 'translate_text_offline', arguments: { text: '你好', target: 'en' } })).isError, true);
  assert.equal((await client.callTool({ name: 'prepare_bilingual_request', arguments: { text: '你好', url: 'https://example.com' } })).isError, true);
  const prompt = await client.getPrompt({ name: 'bilingual_request', arguments: { text: '请保留全部句意。' } });
  assert.ok(prompt.messages[0].content.text.includes('请保留全部句意。'));
  assert.equal((await client.listPrompts()).prompts[0].name, 'bilingual_request');
});

test('auto-start waits for MCP initialization, and explicit open can reopen a previously closed companion', async t => {
  let opens = 0;
  const server = createExtensionServer({ config: { mode: 'account' }, open: async () => ({ opened: ++opens }) });
  assert.equal(opens, 0);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await server.connect(serverTransport); await client.connect(clientTransport);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(opens, 1);
  await client.callTool({ name: 'open_translation_window', arguments: {} }); assert.equal(opens, 2);
});

test('manifest defaults to strict API translation and keeps its key sensitive and legacy mode explicitly opt-in', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.user_config.offline_mode.default, false);
  assert.equal(manifest.user_config.legacy_account_mode.default, false);
  assert.equal(manifest.user_config.translation_api_key.sensitive, true);
  assert.equal(manifest.user_config.translation_base_url.default, 'https://api.deepseek.com');
});

test('offline MCP translation ensures its local service is ready, while account mode never invokes it', async t => {
  let starts = 0;
  const server = createExtensionServer({ config: { mode: 'offline' }, autoStart: false, ensure: async () => { starts++; }, request: async (_config, route, _method, body) => {
    assert.equal(route, '/prepare'); return { text: 'Do not execute it.', englishOnly: true, originalIncluded: false };
  } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' }); t.after(() => client.close());
  await server.connect(serverTransport); await client.connect(clientTransport);
  const response = await client.callTool({ name: 'translate_text_offline', arguments: { text: '不要执行。', target: 'en' } });
  assert.equal(response.structuredContent.text, 'Do not execute it.'); assert.equal(starts, 1);
  assert.equal((await client.callTool({ name: 'translate_text_offline', arguments: { text: 'Hello', target: 'zh' } })).isError, true);
});

test('default API MCP never exposes legacy Chinese-returning tools and rejects contaminated translation results', async t => {
  const server = createExtensionServer({ config: { mode: 'api' }, autoStart: false, ensure: async () => {}, request: async () => ({ text: 'Still 中文' }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close()); await server.connect(serverTransport); await client.connect(clientTransport);
  const list = await client.listTools(); assert.deepEqual(list.tools.map(t => t.name), ['translator_status', 'open_translation_window', 'prepare_english_request']);
  const result = await client.callTool({ name: 'prepare_english_request', arguments: { text: '你好' } }); assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes('中文'));
  assert.equal((await client.callTool({ name: 'prepare_bilingual_request', arguments: { text: '你好' } })).isError, true);
  await assert.rejects(client.getPrompt({ name: 'bilingual_request', arguments: { text: '你好' } }));
});
