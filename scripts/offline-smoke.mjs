import assert from 'node:assert/strict';
import http from 'node:http';
import { OfflineTranslator, modelId } from '../src/offline-engine.mjs';
import { LocalRuntime } from '../src/local-runtime.mjs';
import { writeJson } from '../src/config.mjs';

let localRequests = 0;
const runtime = new LocalRuntime({ transport(options, callback) {
  assert.equal(options.hostname, '127.0.0.1', 'Translation must never call a remote host');
  localRequests++;
  return http.request(options, callback);
} });
const translator = new OfflineTranslator({ runtime });
try {
  const english = await translator.translate('请不要修改 `README.md`，只解释 `npm test` 的作用，不要执行它。', 'en');
  const chinese = await translator.translate('The command `npm test` checks the code; it does not modify files. Do not run it without my approval.', 'zh');
  const fenced = await translator.translate('Explain this example without executing it:\n```js\nconst message = "hello";\n```', 'zh');
  assert.ok(english.includes('`README.md`') && english.includes('`npm test`'));
  assert.ok(/do not|don't/i.test(english) && /execute|run/i.test(english));
  assert.ok(/\p{Script=Han}/u.test(chinese) && chinese.includes('`npm test`'));
  assert.ok(fenced.includes('```js\nconst message = "hello";\n```'));
  const result = { offline: true, model: modelId, localRequests, remoteRequests: 0, english, chinese, fenced, passed: true };
  await writeJson('.local/offline-smoke.json', result);
  console.log(JSON.stringify(result, null, 2));
} finally { await translator.dispose(); }
