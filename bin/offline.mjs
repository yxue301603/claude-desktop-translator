#!/usr/bin/env node
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exists, readJson, writeJson } from '../src/config.mjs';
import { OfflineTranslator, modelId } from '../src/offline-engine.mjs';
import { ensureRuntime } from '../src/ollama-process.mjs';
import { createOfflineService } from '../src/offline-service.mjs';
import { useOfficialAccount } from '../src/account-mode.mjs';

const directory = path.join(homedir(), '.claude-desktop-translator');
const settingsPath = path.join(directory, 'offline.json');
const command = process.argv[2] || 'launch';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function settings() {
  if (!(await exists(settingsPath))) await writeJson(settingsPath, { port: 19877, token: randomBytes(32).toString('hex') });
  return readJson(settingsPath);
}
async function operation(config, route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, { method, headers: { 'x-local-token': config.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(route === '/status' ? 3000 : 180000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Local HTTP ${response.status}`);
  return result;
}
async function ready(config) {
  try { return (await operation(config, '/status')).model === modelId; } catch { return false; }
}
async function start(config) {
  if (await ready(config)) return;
  await ensureRuntime();
  let existing;
  try { existing = await operation(config, '/status'); } catch { /* not running */ }
  if (existing?.service === 'claude-offline-translator') {
    if (existing.active) throw new Error('An older translation is still running. Wait for it to finish and relaunch.');
    await operation(config, '/shutdown', 'POST');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await mkdir(directory, { recursive: true });
  const log = await open(path.join(directory, 'offline-service.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await log.close();
  for (let i = 0; i < 80; i++) { if (await ready(config)) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('Offline service did not start. Start Ollama and run npm run models first.');
}
async function main() {
  const config = await settings();
  if (command === 'setup') {
    console.log(JSON.stringify(await useOfficialAccount()));
    console.log('Account mode configured. Run npm run models, fully exit Claude, then use the launcher.');
  } else if (command === 'serve') {
    const translator = new OfflineTranslator();
    await translator.load('en'); await translator.load('zh');
    const { server } = createOfflineService({ token: config.token, translator });
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.on('close', () => translator.dispose());
    server.listen(config.port, '127.0.0.1', () => console.log('Offline models ready; translation performs no remote requests.'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
  } else if (command === 'status') console.log(JSON.stringify(await operation(config, '/status'), null, 2));
  else if (command === 'stop') console.log(JSON.stringify(await operation(config, '/shutdown', 'POST')));
  else if (command === 'translate') {
    await start(config);
    console.log(JSON.stringify(await operation(config, '/translate', 'POST', { target: process.argv[3], text: process.argv.slice(4).join(' ') }), null, 2));
  } else if (command === 'launch' || command === 'start') {
    await start(config);
    if (command === 'launch') {
      if (process.platform !== 'win32') throw new Error('Desktop accessibility integration currently supports Windows only.');
      const executable = path.join(homedir(), 'AppData', 'Local', 'AnthropicClaude', 'claude.exe');
      const app = spawn(executable, ['--force-renderer-accessibility'], { detached: true, stdio: 'ignore' }); app.unref();
      const log = await open(path.join(directory, 'desktop-bridge.log'), 'a');
      const bridge = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'windows', 'start-bridge.ps1'), '-Config', settingsPath], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] }); bridge.unref(); await log.close();
    }
    console.log('Offline translator ready. Claude uses its own signed-in account.');
  } else throw new Error('Commands: setup, launch, start, serve, status, stop, translate en|zh TEXT');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
