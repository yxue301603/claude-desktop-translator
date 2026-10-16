import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { LocalRuntime } from '../src/local-runtime.mjs';

test('runtime requests are bound to loopback and cannot use a remote route or download models', async t => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ model_info: { architecture: 'hunyuan-dense' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const runtime = new LocalRuntime({ port: server.address().port, transport(options, callback) { assert.equal(options.hostname, '127.0.0.1'); return http.request(options, callback); } });
  await runtime.post('/api/show', { model: 'local-test' });
  assert.deepEqual(received, [{ method: 'POST', path: '/api/show', body: { model: 'local-test' } }]);
  await assert.rejects(runtime.post('https://example.com/api/chat', {}), /Unsupported/);
  await assert.rejects(runtime.post('/api/pull', {}), /Unsupported/);
  assert.equal(received.length, 1);
});

test('runtime surfaces malformed and failed responses rather than returning an incomplete translation', async t => {
  const server = http.createServer((request, response) => { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'model is not installed' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const runtime = new LocalRuntime({ port: server.address().port });
  await assert.rejects(runtime.post('/api/chat', {}), /not installed/);
});
