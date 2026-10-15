import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { useOfficialAccount } from '../src/account-mode.mjs';
import { readJson, writeJson, exists } from '../src/config.mjs';

test('account setup backs up provider mode and preserves all unrelated desktop preferences', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-account-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileRoot = path.join(root, 'profile');
  const stateRoot = path.join(root, 'state');
  const file = path.join(profileRoot, 'claude_desktop_config.json');
  const original = { deploymentMode: '3p', preferences: { theme: 'dark' }, unrelated: 'preserved' };
  await writeJson(file, original);
  assert.deepEqual(await useOfficialAccount({ profileRoot, stateRoot }), { changed: true, restartRequired: true });
  assert.deepEqual(await readJson(file), { ...original, deploymentMode: '1p' });
  assert.deepEqual(await readJson(path.join(stateRoot, 'before-official-account.json')), original);
  assert.deepEqual(await useOfficialAccount({ profileRoot, stateRoot }), { changed: false });
  assert.deepEqual(await readJson(path.join(stateRoot, 'before-official-account.json')), original);
});

test('account setup does not create or replace an absent desktop configuration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-account-absent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await useOfficialAccount({ profileRoot: root, stateRoot: path.join(root, 'state') }), { changed: false });
  assert.equal(await exists(path.join(root, 'claude_desktop_config.json')), false);
});
