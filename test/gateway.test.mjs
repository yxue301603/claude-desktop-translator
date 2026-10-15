import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createGateway } from '../src/server.mjs';
import { encodeEvent, parseSse, decodeFrame } from '../src/sse.mjs';

const token = 'local-gateway-test-token-at-least-24-chars';
async function fixture(t, { failing = false, streaming = false } = {}) {
  const received = [];
  const translations = [];
  const translator = {
    metrics: {},
    translate: async (text, target) => {
      translations.push([text, target]);
      if (failing) throw new Error('Translation provider returned HTTP 503');
      return text.replace('请问你好', 'Please say hello').replace('Hello from upstream.', '来自上游的问候。');
    },
  };
  const { server } = createGateway({ gatewayToken: token, upstreamBaseUrl: 'https://provider.example/anthropic', upstreamApiKey: 'upstream-secret', upstreamModel: 'real-model', modelAliases: ['desktop-alias'], requestTimeoutMs: 10000 }, {
    translator,
    fetchImpl: async (url, options) => {
      received.push({ url, options, body: JSON.parse(options.body) });
      if (streaming) {
        const events = [
          { type: 'message_start', message: { id: 'msg_test' } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from upstream.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ];
        return new Response(events.map(encodeEvent).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ id: 'msg_test', content: [{ type: 'text', text: 'Hello from upstream.' }, { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'echo unchanged' } }] });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, received, translations };
}
const request = { model: 'desktop-alias', messages: [{ role: 'user', content: '请问你好' }] };
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': token }, body: JSON.stringify(body) });

test('gateway sends actual English upstream and returns Chinese with the tool arguments intact', async t => {
  const { base, received } = await fixture(t);
  const response = await fetch(`${base}/v1/messages?beta=true`, post(request));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(received[0].body.messages[0].content, 'Please say hello');
  assert.equal(received[0].body.model, 'real-model');
  assert.equal(received[0].url, 'https://provider.example/anthropic/v1/messages?beta=true');
  assert.equal(received[0].options.headers['x-api-key'], 'upstream-secret');
  assert.equal(body.content[0].text, '来自上游的问候。');
  assert.equal(body.content[1].input.command, 'echo unchanged');
  assert.ok(!JSON.stringify(body).includes('upstream-secret'));
});

test('translation errors block submission of original Chinese', async t => {
  const { base, received } = await fixture(t, { failing: true });
  const response = await fetch(`${base}/v1/messages`, post(request));
  assert.equal(response.status, 502);
  assert.equal(received.length, 0);
  assert.match((await response.json()).error.message, /Translation provider/);
});

test('loopback service rejects missing credentials, browser origins, foreign hosts and malformed requests', async t => {
  const { base, received } = await fixture(t);
  assert.equal((await fetch(`${base}/v1/messages`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/v1/messages`, { ...post(request), headers: { ...post(request).headers, Origin: 'https://evil.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/v1/messages`, { method: 'POST', headers: { Host: 'evil.example', 'x-api-key': token } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(request));
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/v1/messages`, post({}))).status, 400);
  assert.equal((await fetch(`${base}/v1/messages`, { ...post(request), body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/anything`, post(request))).status, 404);
  assert.equal(received.length, 0);
});

test('authenticated model discovery and metadata status work for desktop startup', async t => {
  const { base } = await fixture(t);
  const headers = { 'x-api-key': token };
  assert.equal((await (await fetch(`${base}/healthz`)).json()).service, 'claude-desktop-translator');
  const models = await (await fetch(`${base}/v1/models`, { headers })).json();
  assert.equal(models.data[0].id, 'desktop-alias');
  const status = await (await fetch(`${base}/status`, { headers })).json();
  assert.equal(status.active, 0);
  assert.equal(status.requests, 0);
});

test('gateway SSE returns Chinese through an actual HTTP stream', async t => {
  const { base, received } = await fixture(t, { streaming: true });
  const response = await fetch(`${base}/v1/messages`, post({ ...request, stream: true }));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  for await (const frame of parseSse(response.body)) events.push(decodeFrame(frame));
  assert.equal(events.find(event => event?.delta?.type === 'text_delta').delta.text, '来自上游的问候。');
  assert.equal(received[0].body.messages[0].content, 'Please say hello');
});

test('structured output requested by SDK helpers bypasses response translation', async t => {
  const { base, translations } = await fixture(t);
  const response = await fetch(`${base}/v1/messages`, post({ ...request, output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } }));
  assert.equal((await response.json()).content[0].text, 'Hello from upstream.');
  assert.deepEqual(translations, [['请问你好', 'en']]);
});
