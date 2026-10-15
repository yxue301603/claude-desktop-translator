import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { OfflineTranslator, literalSegments, splitProse } from '../src/offline-engine.mjs';
import { createOfflineService } from '../src/offline-service.mjs';

test('offline segmentation round-trips fenced and inline code without passing it to a model', async () => {
  const text = '请执行 `npm test`。\n```js\n// 中文\nconst text = "hello";\n```\n打开 C:\\项目\\app.js';
  const segments = literalSegments(text);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  const calls = [];
  const translator = new OfflineTranslator({ createPipeline: async () => async source => { calls.push(source); return [{ translation_text: source.replace('请执行', 'Please run').replace('打开', 'Open') }]; } });
  const result = await translator.translate(text, 'en');
  assert.ok(result.includes('```js\n// 中文\nconst text = "hello";\n```'));
  assert.ok(result.includes('`npm test`'));
  assert.ok(result.includes('C:\\项目\\app.js'));
  assert.ok(calls.every(call => !call.includes('npm test') && !call.includes('const text') && !call.includes('C:\\')));
});

test('prose splitting preserves Markdown structure and limits model input lengths', () => {
  const text = '# Heading\n\n- ' + 'A sentence. '.repeat(100) + '\n';
  const pieces = splitProse(text, 100);
  assert.equal(pieces.map(piece => piece.text).join(''), text);
  assert.ok(pieces.filter(piece => !piece.literal).every(piece => piece.text.length <= 100));
});

test('raw JSON data remains literal rather than translating object keys or values', async () => {
  const translator = new OfflineTranslator({ createPipeline: async () => { throw new Error('JSON must not reach the model'); } });
  const json = '{"name":"测试项目","command":"npm test"}';
  assert.equal(await translator.translate(json, 'en'), json);
});

test('offline inference explicitly disables remote model loading and caches completed translations', async () => {
  const options = [];
  let calls = 0;
  const translator = new OfflineTranslator({ createPipeline: async (task, model, config) => {
    options.push(config);
    return async text => { calls++; return [{ translation_text: 'Hello' }]; };
  } });
  assert.equal(await translator.translate('你好', 'en'), 'Hello');
  assert.equal(await translator.translate('你好', 'en'), 'Hello');
  assert.equal(calls, 1);
  assert.equal(options[0].local_files_only, true);
  assert.equal(options[0].device, 'cpu');
  await assert.rejects(() => translator.translate('hello', 'fr'), /Target/);
});

test('offline inference serializes calls and recovers after a failed inference', async () => {
  let active = 0;
  let peak = 0;
  let fail = true;
  const translator = new OfflineTranslator({ createPipeline: async () => async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (fail) { fail = false; throw new Error('temporary failure'); }
    return [{ translation_text: 'hello' }];
  } });
  const results = await Promise.allSettled([translator.translate('一', 'en'), translator.translate('二', 'en')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].value, 'hello');
  assert.equal(peak, 1);
});

test('local translation service authenticates and exposes no model proxy endpoints', async t => {
  const token = 'test-local-token';
  const calls = [];
  const { server } = createOfflineService({ token, translator: { translate: async (text, target) => { calls.push([text, target]); return 'hello'; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-local-token': token, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/status')).status, 401);
  assert.equal((await post('/translate', { text: '你好', target: 'en' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('/v1/messages', { messages: [] })).status, 404);
  assert.equal((await post('/translate', { text: '你好', target: 'invalid' })).status, 400);
  const response = await post('/translate', { text: '你好', target: 'en' });
  assert.deepEqual(await response.json(), { text: 'hello' });
  assert.deepEqual(calls, [['你好', 'en']]);
});
