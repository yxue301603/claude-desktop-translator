import test from 'node:test';
import assert from 'node:assert/strict';
import { runService } from '../src/service-runtime.mjs';

test('account runtime binds and closes without loading a translator or launching a child Node process', async t => {
  const { server } = await runService({ mode: 'account', port: 0, token: 'runtime-test-token' }, 'test');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  const result = await fetch(`http://127.0.0.1:${server.address().port}/status`, { headers: { 'x-local-token': 'runtime-test-token' } });
  const status = await result.json();
  assert.equal(status.mode, 'account'); assert.equal(status.offline, false);
  assert.equal(status.version, 'test');
});
