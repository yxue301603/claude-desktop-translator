import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mode, operation, configurationMode } from '../src/desktop-controller.mjs';
import { companionCommand } from '../src/powershell-command.mjs';

test('only explicit account and offline modes are accepted', () => {
  assert.equal(mode(), 'api'); assert.equal(mode('offline'), 'offline');
  assert.throws(() => mode('https://example.com'), /mode/);
});

test('upgrade migrates legacy auto-Chinese defaults to API, retains offline and requires explicit opt-in for legacy', () => {
  assert.equal(configurationMode({ mode: 'account' }), 'api');
  assert.equal(configurationMode({ mode: 'offline' }), 'offline');
  assert.equal(configurationMode({ mode: 'account' }, 'account'), 'account');
  assert.equal(configurationMode({ schemaVersion: 2, mode: 'account' }), 'account');
});

test('companion command preserves spaces and treats apostrophes as literal path characters', () => {
  const args = companionCommand({ script: "C:\\My App\\O'Brien\\start.ps1", config: 'C:\\Profile\\offline.json', ownerPid: 123, ownerLease: 'C:\\Profile\\owner.pid' });
  assert.equal(args.at(-2), '-EncodedCommand');
  const command = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.ok(command.includes("& 'C:\\My App\\O''Brien\\start.ps1'"));
  assert.ok(command.includes('-OwnerPid 123'));
  assert.throws(() => companionCommand({ ownerPid: -1 }), /owner/);
});

test('desktop controller uses authenticated loopback calls and surfaces configuration errors', async t => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-local-token'], 'private-test-token');
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/prepare');
    response.writeHead(409, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Translation is still active' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await assert.rejects(operation({ port: server.address().port, token: 'private-test-token' }, '/prepare', 'POST', { text: 'hello' }), /still active/);
});
