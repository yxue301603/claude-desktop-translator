import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig, defaultConfigPath, writeJson } from '../src/config.mjs';
import { createGateway } from '../src/server.mjs';
import { parseSse, decodeFrame } from '../src/sse.mjs';

const config = await loadConfig(process.argv[2] || defaultConfigPath);
const captured = [];
const { server, translator } = createGateway(config, {
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    const text = body.messages[0].content;
    assert.equal(typeof text, 'string');
    assert.ok(!/\p{Script=Han}/u.test(text), 'Actual upstream prompt must be English');
    assert.ok(text.includes('`npm test`'), 'Input command must remain intact');
    captured.push({ stream: body.stream, englishPrompt: text });
    return fetch(url, options);
  },
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const results = [];
try {
  for (const stream of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': config.gatewayToken },
      body: JSON.stringify({
        model: config.upstreamModel, max_tokens: 256, stream,
        messages: [{ role: 'user', content: '请用英文回复一句话，说明桌面翻译测试成功，并在同一句话保留行内命令 `npm test`。不要调用工具。' }],
      }), signal: AbortSignal.timeout(120000),
    });
    assert.equal(response.status, 200, await (response.ok ? Promise.resolve('') : response.text()));
    let chinese = '';
    if (stream) {
      for await (const frame of parseSse(response.body)) {
        const event = decodeFrame(frame);
        if (event?.type === 'error') throw new Error(event.error.message);
        if (event?.delta?.type === 'text_delta') chinese += event.delta.text;
      }
    } else {
      const body = await response.json();
      chinese = body.content.filter(block => block.type === 'text').map(block => block.text).join('');
    }
    assert.match(chinese, /\p{Script=Han}/u);
    assert.ok(chinese.includes('`npm test`'), 'Output command must remain intact');
    results.push({ stream, englishSent: captured.at(-1).englishPrompt, chineseReceived: chinese, passed: true });
  }
  const report = { checkedAt: new Date().toISOString(), provider: new URL(config.upstreamBaseUrl).hostname, model: config.upstreamModel, results, translationCounters: translator.metrics };
  await writeJson('.local/live-smoke.json', report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.close();
  server.closeAllConnections();
}
