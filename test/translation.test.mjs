import test from 'node:test';
import assert from 'node:assert/strict';
import { protectLiterals, Translator, translateRequest, translateResponse } from '../src/translate.mjs';
import { translateSse, encodeEvent, decodeFrame, parseSse } from '../src/sse.mjs';

test('literal protection preserves code, Chinese comments, URLs and paths byte for byte', () => {
  const input = '请检查 `npm test` 和 C:\\项目\\app.js。\n```js\n// 中文注释\nconsole.log("你好");\n```\n参考 https://example.com/a?q=1。\n结束';
  const protectedText = protectLiterals(input);
  assert.equal(protectedText.restore(protectedText.text), input);
  assert.ok(!protectedText.text.includes('console.log'));
  assert.ok(!protectedText.text.includes('npm test'));
  assert.throws(() => protectedText.restore('lost literals'), /protected literal/);
  assert.throws(() => protectedText.restore(protectedText.text + protectedText.text), /protected literal/);
});

test('tool results, system instructions, attachments and tool arguments are not translated', async () => {
  const body = {
    model: 'test', system: '中文系统指令',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '请检查' }, { type: 'image', source: { type: 'base64', data: 'abc' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool1', name: 'Write', input: { content: '中文文件' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool1', content: '中文工具输出' }] },
    ],
  };
  const original = structuredClone(body);
  const calls = [];
  const translated = await translateRequest(body, { translate: async (text, target) => { calls.push([text, target]); return 'Please check'; } });
  assert.deepEqual(body, original);
  assert.equal(translated.messages[0].content[0].text, 'Please check');
  assert.equal(translated.system, original.system);
  assert.deepEqual(translated.messages.slice(1), original.messages.slice(1));
  assert.deepEqual(translated.messages[0].content[1], original.messages[0].content[1]);
  assert.deepEqual(calls, [['请检查', 'en']]);
});

test('response translation leaves signed thinking and tool blocks untouched', async () => {
  const response = { content: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }, { type: 'text', text: 'Done' }, { type: 'tool_use', input: { command: 'echo done' } }] };
  const translated = await translateResponse(response, { translate: async () => '完成' });
  assert.deepEqual(translated.content[0], response.content[0]);
  assert.deepEqual(translated.content[2], response.content[2]);
  assert.equal(translated.content[1].text, '完成');
});

test('translation caches by language and restores literal data after real response parsing', async () => {
  let calls = 0;
  const translator = new Translator({ translationBaseUrl: 'http://127.0.0.1', translationApiKey: 'secret', translationModel: 'test', translationTimeoutMs: 1000 }, {
    fetchImpl: async (url, options) => {
      calls++;
      const request = JSON.parse(options.body);
      assert.equal(request.messages.length, 1);
      assert.equal(options.redirect, 'error');
      return Response.json({ content: [{ type: 'text', text: request.messages[0].content.replace('请执行', 'Please execute') }], stop_reason: 'end_turn' });
    },
  });
  assert.equal(await translator.translate('请执行 `npm test`', 'en'), 'Please execute `npm test`');
  assert.equal(await translator.translate('请执行 `npm test`', 'en'), 'Please execute `npm test`');
  assert.equal(calls, 1);
  assert.equal(translator.metrics.cacheHits, 1);
  assert.equal(await translator.translate('```js\n// 中文\n```', 'en'), '```js\n// 中文\n```');
  assert.equal(calls, 1);
  assert.equal(await translator.translate('{"status":"allowed","path":"中文文件"}', 'zh'), '{"status":"allowed","path":"中文文件"}');
  assert.equal(calls, 1);
});

test('a prose slash does not protect an English word as an absolute file path', () => {
  const protectedText = protectLiterals('Chinese/English translation with /src/app.js and ./bin/test.mjs');
  assert.ok(protectedText.text.includes('Chinese/English'));
  assert.ok(!protectedText.text.includes('/src/app.js'));
  assert.equal(protectedText.restore(protectedText.text), 'Chinese/English translation with /src/app.js and ./bin/test.mjs');
});

test('SSE translates complete text across byte boundaries and preserves tool JSON and signatures', async () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_test', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking 中文' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'UNCHANGED-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'The result is ready.\n```js\nconsole.' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'log("中文");\n```' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"echo English"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ];
  const bytes = Buffer.from(events.map(encodeEvent).join('').replaceAll('\n', '\r\n'));
  async function* chunks() { for (let i = 0; i < bytes.length; i += 7) yield bytes.subarray(i, i + 7); }
  const calls = [];
  const translator = { translate: async (text, target) => { calls.push([text, target]); return text.replace('The result is ready.', '结果已就绪。'); } };
  let output = '';
  for await (const frame of translateSse(chunks(), translator)) output += frame;
  const parsed = [];
  for await (const frame of parseSse([output])) parsed.push(decodeFrame(frame));
  assert.deepEqual(calls, [['The result is ready.\n```js\nconsole.log("中文");\n```', 'zh']]);
  assert.equal(parsed.find(event => event.delta?.type === 'text_delta').delta.text, '结果已就绪。\n```js\nconsole.log("中文");\n```');
  assert.deepEqual(parsed.filter(event => event.index === 0), events.filter(event => event.index === 0));
  assert.deepEqual(parsed.filter(event => event.index === 2), events.filter(event => event.index === 2));
  assert.deepEqual(parsed.at(-2), events.at(-2));
});

test('a truncated SSE block fails instead of silently dropping the reply', async () => {
  const stream = [encodeEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })];
  await assert.rejects(async () => { for await (const frame of translateSse(stream, {})) void frame; }, /ended before/);
});
