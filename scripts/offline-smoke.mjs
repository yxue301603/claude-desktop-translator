import assert from 'node:assert/strict';
import { OfflineTranslator } from '../src/offline-engine.mjs';
import { writeJson } from '../src/config.mjs';
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network is forbidden in the offline smoke test'); };
const translator = new OfflineTranslator();
try {
  const english = await translator.translate('请打开 `README.md`，不要修改代码。', 'en');
  const source = 'Here is the code:\n```js\nconst message = "hello";\n```\nRun `npm test`.';
  const chinese = await translator.translate(source, 'zh');
  assert.ok(!/\p{Script=Han}/u.test(english));
  assert.ok(english.includes('`README.md`'));
  assert.ok(/\p{Script=Han}/u.test(chinese));
  assert.ok(chinese.includes('```js\nconst message = "hello";\n```'));
  assert.ok(chinese.includes('`npm test`'));
  assert.equal(networkCalls, 0);
  const result = { offline: true, networkCalls, english, chinese, passed: true };
  await writeJson('.local/offline-smoke.json', result);
  console.log(JSON.stringify(result, null, 2));
} finally { await translator.dispose(); globalThis.fetch = originalFetch; }
