import test from 'node:test';
import assert from 'node:assert/strict';
import { OfflineTranslator, modelId } from '../src/offline-engine.mjs';
import { prepareTranslation, translationUnits } from '../src/context.mjs';

const sourceOf = body => body.messages[0].content.split('\n待译文本：\n').at(-1);
const complete = text => ({ done: true, done_reason: 'stop', message: { content: text } });
function mockRuntime(infer) {
  const calls = [];
  return { calls, async post(route, body) { calls.push({ route, body }); if (route === '/api/show') return {}; if (route === '/api/chat') return infer(body); return {}; } };
}

test('inline literals stay inside a complete paragraph sent in one inference', async () => {
  const runtime = mockRuntime(body => complete(sourceOf(body).replace('请不要修改', 'Do not modify').replace('，只解释', '; only explain').replace(' 的作用，不要执行它。', '; do not execute it.')));
  const translator = new OfflineTranslator({ runtime });
  const source = '请不要修改 `README.md`，只解释 `npm test` 的作用，不要执行它。';
  const output = await translator.translate(source, 'en');
  assert.equal(output, 'Do not modify `README.md`; only explain `npm test`; do not execute it.');
  const chats = runtime.calls.filter(call => call.route === '/api/chat');
  assert.equal(chats.length, 1);
  assert.ok(sourceOf(chats[0].body).startsWith('请不要修改 __CDT_'));
  assert.ok(sourceOf(chats[0].body).endsWith('的作用，不要执行它。'));
  assert.ok(!sourceOf(chats[0].body).includes('npm test'));
  assert.equal(chats[0].body.model, modelId);
});

test('adjacent paragraphs and their cross-paragraph references remain in the same inference', async () => {
  const runtime = mockRuntime(body => complete(sourceOf(body).replace('创建', 'Create').replace('只修改副本', 'Only modify the copy')));
  const translator = new OfflineTranslator({ runtime });
  const output = await translator.translate('  创建 `report.txt`。\n\n只修改副本。\n', 'en');
  assert.equal(output, '  Create `report.txt`。\n\nOnly modify the copy。\n');
  const chats = runtime.calls.filter(call => call.route === '/api/chat');
  assert.equal(chats.length, 1);
  assert.ok(sourceOf(chats[0].body).includes('。\n\n只修改副本。'));
});

test('long paragraphs split only at sentence boundaries; an oversized sentence fails before inference', async () => {
  const sentence = 'This sentence retains its entire meaning. ';
  const text = sentence.repeat(8);
  const units = translationUnits(text, 90);
  assert.equal(units.map(unit => unit.text).join(''), text);
  assert.ok(units.every(unit => unit.text.length <= 90 && unit.text.trimEnd().endsWith('.')));
  assert.throws(() => translationUnits('词'.repeat(101), 100), /single sentence/);
  const runtime = mockRuntime(() => { throw new Error('Must not infer fragments'); });
  await assert.rejects(new OfflineTranslator({ runtime }).translate('短段。\n\n' + '词'.repeat(1900), 'en'), /single sentence/);
  assert.equal(runtime.calls.length, 0);
});

test('documents larger than one inference retain previous paragraph context', async () => {
  const first = '先创建一个副本。'.repeat(160);
  const second = '只修改副本，原文件保持不变。'.repeat(50);
  const runtime = mockRuntime(() => complete('Translated paragraph.'));
  await new OfflineTranslator({ runtime }).translate(first + '\n\n' + second, 'en');
  const chats = runtime.calls.filter(call => call.route === '/api/chat');
  assert.equal(chats.length, 2);
  assert.equal(sourceOf(chats[0].body), first);
  assert.equal(sourceOf(chats[1].body), second);
  assert.ok(chats[1].body.messages[0].content.includes(first + '\n\n'));
});

test('fenced code, raw JSON, and code-only inputs never get translated', async () => {
  const runtime = mockRuntime(body => complete(sourceOf(body).replace('请解释：', 'Explain:')));
  const translator = new OfflineTranslator({ runtime });
  const fence = '```js\n// 中文\nconst x = "hello";\n```';
  assert.equal(await translator.translate('请解释：\n' + fence, 'en'), 'Explain:\n' + fence);
  const count = runtime.calls.length;
  assert.equal(await translator.translate(fence, 'zh'), fence);
  assert.equal(await translator.translate('{"name":"测试项目"}', 'en'), '{"name":"测试项目"}');
  assert.equal(runtime.calls.length, count);
});

test('a URL does not hide Chinese instructions after punctuation', () => {
  const prepared = prepareTranslation('访问 https://example.com/upload，也不要上传或删除文件。');
  assert.equal(prepared.literals[0].literal, 'https://example.com/upload');
  assert.ok(prepared.prose(prepared.text).includes('也不要上传或删除文件'));
  assert.equal(prepared.restore(prepared.text), '访问 https://example.com/upload，也不要上传或删除文件。');
});

test('missing, repeated, reordered, and unknown placeholders are rejected without fragment fallback', async () => {
  for (const corrupt of [tokens => tokens[0], tokens => tokens.join(' ') + ' ' + tokens[0], tokens => [...tokens].reverse().join(' '), tokens => tokens.join(' ') + ' __CDT_abcdef123456_9__']) {
    const runtime = mockRuntime(body => complete(corrupt(sourceOf(body).match(/__CDT_[a-f0-9]+_\d+__/g))));
    await assert.rejects(new OfflineTranslator({ runtime }).translate('从 `source` 复制到 `destination`，不要反过来。', 'en'), /protected literal/);
    assert.equal(runtime.calls.filter(call => call.route === '/api/chat').length, 1);
  }
});

test('truncated or unfinished output is rejected and not cached', async () => {
  let first = true;
  const runtime = mockRuntime(() => first ? (first = false, { ...complete('Partial'), done_reason: 'length' }) : complete('Complete translation'));
  const translator = new OfflineTranslator({ runtime });
  await assert.rejects(translator.translate('完整句意', 'en'), /incomplete/);
  assert.equal(await translator.translate('完整句意', 'en'), 'Complete translation');
  assert.equal(await translator.translate('完整句意', 'en'), 'Complete translation');
  assert.equal(runtime.calls.filter(call => call.route === '/api/chat').length, 2);
});

test('one installed local model is shared between directions and cloud models are refused', async () => {
  const runtime = mockRuntime(() => complete('translation'));
  const translator = new OfflineTranslator({ runtime });
  await translator.translate('你好', 'en'); await translator.translate('Hello', 'zh');
  assert.equal(runtime.calls.filter(call => call.route === '/api/show').length, 1);
  await assert.rejects(translator.translate('Hello', 'fr'), /Target/);
  await assert.rejects(new OfflineTranslator({ runtime: { post: async () => ({ remote_host: 'https://cloud.example' }) } }).translate('你好', 'en'), /Cloud models/);
});

test('inference stays serial and recovers after a failed request', async () => {
  let active = 0, peak = 0, first = true;
  const runtime = mockRuntime(async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (first) { first = false; throw new Error('temporary failure'); }
    return complete('Hello');
  });
  const translator = new OfflineTranslator({ runtime });
  const results = await Promise.allSettled([translator.translate('一', 'en'), translator.translate('二', 'en')]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].value, 'Hello'); assert.equal(peak, 1);
});
