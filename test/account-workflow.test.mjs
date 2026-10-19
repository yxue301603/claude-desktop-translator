import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { prepareAccountRequest, extractAccountResponse } from '../src/account-workflow.mjs';
import { createOfflineService } from '../src/offline-service.mjs';

const id = '0123456789abcdef';
const marked = (englishInput, englishAnswer, chinese) => `CDT_${id}_ENGLISH_INPUT\n${englishInput}\nCDT_${id}_ENGLISH_ANSWER\n${englishAnswer}\nCDT_${id}_CHINESE_ANSWER\n${chinese}\nCDT_${id}_END`;

test('account mode preserves the original source and discloses that it is sent without local pretranslation', () => {
  const source = '只有测试通过才继续，不要修改原文件。\n```js\nconst text = "你好";\n```';
  const prepared = prepareAccountRequest(source, id);
  assert.ok(prepared.text.includes(source));
  assert.match(prepared.text, /Chinese text is intentionally included/);
  assert.match(prepared.text, /entire English answer/);
  assert.equal((prepared.text.match(/CDT_[a-f0-9]{16}_/g) || []).length, 4);
  assert.notEqual(prepareAccountRequest(source).id, prepareAccountRequest(source).id);
  assert.throws(() => prepareAccountRequest(''), /Enter/);
  assert.throws(() => prepareAccountRequest('a'.repeat(24001)), /24000/);
});

test('all Chinese sentences and exact code survive response extraction', () => {
  const chinese = '第一句话。第二句话保留条件。\n\n不要执行 `npm test`。\n```js\nconst value = 3;\nconsole.log(value);\n```\n你想继续吗？';
  const result = extractAccountResponse(marked('Explain the example.', 'First sentence. Second sentence.\nDo not run `npm test`.', chinese));
  assert.equal(result.text, chinese);
  assert.equal(result.englishInput, 'Explain the example.');
  assert.match(result.englishAnswer, /Second sentence/);
});

test('incomplete, duplicate, reordered, mixed, and empty sections are rejected without summary fallback', () => {
  const complete = marked('Input', 'Answer', '完整中文。');
  for (const bad of [complete.replace(`CDT_${id}_END`, ''), complete + `CDT_${id}_END`, complete.replace('ENGLISH_INPUT', 'ENGLISH_ANSWER'), complete.replace(`CDT_${id}_END`, 'CDT_aaaaaaaaaaaaaaaa_END'), marked('Input', 'Answer', ''), 'Only the first sentence.'])
    assert.throws(() => extractAccountResponse(bad));
});

test('account service starts without a translator and never claims to have locally translated a request', async t => {
  const { server } = createOfflineService({ token: 'test-token', mode: 'account', version: 'test' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-local-token': 'test-token', 'Content-Type': 'application/json' };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const status = await (await fetch(base + '/status', { headers })).json();
  assert.equal(status.mode, 'account'); assert.equal(status.offline, false);
  const prepared = await (await post('/prepare', { text: '请解释，不要执行。' })).json();
  assert.ok(prepared.text.includes('请解释，不要执行。'));
  assert.equal((await post('/prepare', { text: '' })).status, 400);
  assert.equal((await post('/translate', { text: '你好', target: 'en' })).status, 409);
  assert.equal((await post('/extract', { text: 'Partial' })).status, 422);
  assert.equal((await (await post('/extract', { text: marked('Input', 'Answer', '第一句。第二句。') })).json()).text, '第一句。第二句。');
  assert.equal((await fetch(base + '/prepare', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })).status, 403);
});
