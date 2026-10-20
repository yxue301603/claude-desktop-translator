import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiTranslator, apiSettings } from '../src/api-translator.mjs';
import { assertEnglishSubmission, prepareEnglishSubmission } from '../src/submission.mjs';
import { createOfflineService } from '../src/offline-service.mjs';
import { runService } from '../src/service-runtime.mjs';

const config = { endpoint: 'https://api.deepseek.com/chat/completions', host: 'api.deepseek.com', model: 'test-model', key: 'fixture-key-not-a-credential' };
const reply = (text, finish = 'stop') => Response.json({ choices: [{ finish_reason: finish, message: { content: text } }] });

test('API request contract preserves code and numbers, translates whole context, caches and never enables model thinking', async () => {
  const calls = [];
  const engine = new ApiTranslator({ config, fetchImpl: async (url, request) => {
    calls.push({ url, request });
    const body = JSON.parse(request.body), source = JSON.parse(body.messages[1].content).text;
    const tokens = source.match(/__CDT_[a-f0-9]{12}_\d+__/g);
    return reply(`Proceed only if the tests pass within 250 ms. Do not execute ${tokens[0]}.\n${tokens[1]}`);
  } });
  const source = '只有测试通过且耗时不超过 250 毫秒才继续。不要执行 `npm test`。\n```js\nconst value = 3;\n```';
  const result = await prepareEnglishSubmission(engine, source);
  assert.equal(result.text, 'Proceed only if the tests pass within 250 ms. Do not execute `npm test`.\n```js\nconst value = 3;\n```');
  assert.equal(result.originalIncluded, false); assert.equal(result.englishOnly, true);
  assert.equal((await prepareEnglishSubmission(engine, source)).text, result.text); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.endpoint); assert.equal(calls[0].request.redirect, 'error');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer ' + config.key);
  assert.deepEqual(JSON.parse(calls[0].request.body).thinking, { type: 'disabled' });
});

test('strict submission rejects Chinese in prose, protected code, paths and supplementary characters without a fallback', async () => {
  for (const text of ['English with 中文', '```js\nconst s="你好";\n```', 'C:\\资料\\file.txt', '\u{20000}']) assert.throws(() => assertEnglishSubmission(text));
  const engine = new ApiTranslator({ config: { ...config, key: '' }, fetchImpl: () => assert.fail('No request may be made without a key') });
  await assert.rejects(prepareEnglishSubmission(engine, '你好'), /API Key/);
  await assert.rejects(prepareEnglishSubmission(engine, '```js\nconst s="你好";\n```'), /中文/);
  assert.equal((await prepareEnglishSubmission(engine, 'Explain this code.')).text, 'Explain this code.');
});

test('API rejects truncated, altered literal/number, reasoning-only, invalid and error responses without leaking provider bodies', async () => {
  const source = '不要执行 `npm test`，最多 250 毫秒。';
  for (const response of [reply('Partial', 'length'), reply('No placeholder, 250 ms.'), reply('No placeholder, 25 ms.'), reply('<think>internal</think>'), Response.json({ choices: [{ finish_reason: 'stop', message: { reasoning_content: 'Only reasoning' } }] }), new Response('invalid'), new Response('Echoed private content', { status: 401 })]) {
    const engine = new ApiTranslator({ config, fetchImpl: async () => response });
    await assert.rejects(engine.translate(source, 'en'), error => !error.message.includes('Echoed private content') && !error.message.includes(config.key));
  }
  const altered = new ApiTranslator({ config, fetchImpl: async () => reply('Continue within 25 ms.') });
  await assert.rejects(altered.translate('在 250 毫秒内继续。', 'en'), /数值/);
  const failure = new ApiTranslator({ config, fetchImpl: async () => { throw Error('private transport diagnostic'); } });
  await assert.rejects(failure.translate('你好', 'en'), error => !error.message.includes('private transport'));
  let attempts = 0;
  const retry = new ApiTranslator({ config, fetchImpl: async () => reply(++attempts === 1 ? 'Still 中文' : 'Hello') });
  await assert.rejects(retry.translate('你好', 'en'), /中文/);
  assert.equal(await retry.translate('你好', 'en'), 'Hello');
  assert.equal(attempts, 2, 'Rejected Chinese output must not poison the retry cache');
});

test('API settings default to official HTTPS, support v1 and full endpoints, reject insecure or credential-bearing URLs', () => {
  assert.equal(apiSettings({}).endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(apiSettings({ CDT_TRANSLATION_BASE_URL: 'https://example.com/v1' }).endpoint, 'https://example.com/v1/chat/completions');
  assert.equal(apiSettings({ CDT_TRANSLATION_BASE_URL: 'https://example.com/v1/chat/completions' }).endpoint, 'https://example.com/v1/chat/completions');
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=secret', 'https://example.com/#fragment']) assert.throws(() => apiSettings({ CDT_TRANSLATION_BASE_URL: value }));
});

test('real loopback API service prepares English only, rejects residual Chinese and authenticates output translation', async t => {
  const translator = { model: 'fixture', configured: true, translate: async (text, target) => target === 'zh' ? '公开思考：先核对条件，再作答。' : text === '保留中文' ? '残留中文' : 'Proceed only after tests pass.' };
  const { server } = createOfflineService({ mode: 'api', token: 'fixture-token', translator });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, text, token = 'fixture-token') => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-local-token': token }, body: JSON.stringify({ text, target: 'zh' }) });
  const prepared = await (await post('/prepare', '测试通过才继续')).json(); assert.equal(prepared.text, 'Proceed only after tests pass.'); assert.equal(prepared.originalIncluded, false);
  assert.equal((await post('/prepare', '保留中文')).status, 400);
  assert.equal((await post('/translate', 'I will compare constraints first.')).status, 200);
  assert.equal((await post('/translate', 'Hello', 'wrong')).status, 401);
});

test('API runtime starts without a key or local model and rejects Chinese preparation rather than sending the source', async t => {
  const previous = process.env.CDT_TRANSLATION_API_KEY;
  delete process.env.CDT_TRANSLATION_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.CDT_TRANSLATION_API_KEY; else process.env.CDT_TRANSLATION_API_KEY = previous; });
  const { server } = await runService({ mode: 'api', port: 0, token: 'fixture-token' }, 'test');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { 'x-local-token': 'fixture-token', 'Content-Type': 'application/json' };
  const status = await (await fetch(base + '/status', { headers })).json(); assert.equal(status.mode, 'api'); assert.equal(status.englishOnly, true); assert.equal(status.offline, false);
  assert.ok(!JSON.stringify(status).includes('fixture-token'));
  const result = await fetch(base + '/prepare', { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
  assert.equal(result.status, 400); assert.match((await result.json()).error, /API Key/);
});
