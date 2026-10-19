import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { companionCommand, spawnPowerShell } from '../src/powershell-command.mjs';

test('Windows launcher executes its script rather than silently exiting 0, preserving literal path arguments', { skip: process.platform !== 'win32' }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "CDT O'Brien "));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const script = path.join(folder, 'fixture.ps1');
  const result = path.join(folder, 'result.txt');
  const lease = "draft's owner";
  await writeFile(script, 'param([string]$Config,[int]$OwnerPid,[string]$OwnerLease)\n[IO.File]::WriteAllText($Config,$OwnerPid.ToString()+\":\"+$OwnerLease)\n');
  const child = spawnPowerShell(companionCommand({ script, config: result, ownerPid: 123, ownerLease: lease }));
  let errors = ''; child.stderr.on('data', chunk => errors += chunk); child.stdout.resume();
  const timer = setTimeout(() => child.kill(), 15000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, errors);
  assert.equal(await readFile(result, 'utf8'), '123:' + lease);
});
