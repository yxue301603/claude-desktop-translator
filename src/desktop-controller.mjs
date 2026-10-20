import http from 'node:http';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exists, readJson, writeJson } from './config.mjs';
import { runService } from './service-runtime.mjs';
import { companionCommand, spawnPowerShell } from './powershell-command.mjs';
import { apiConfigurationId } from './api-translator.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
export const stateDirectory = process.env.CDT_STATE_DIRECTORY || path.join(homedir(), '.claude-desktop-translator');
export const settingsPath = path.join(stateDirectory, 'offline.json');
export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ownedServices = new Map();

export function mode(value = 'api') {
  if (!['api', 'account', 'offline'].includes(value)) throw new Error('Translation mode must be api, account or offline.');
  return value;
}
export function configurationMode(config, explicit) {
  const saved = config.schemaVersion === 2 ? config.mode : config.mode === 'offline' ? 'offline' : 'api';
  return mode(explicit || saved || 'api');
}

export async function settings(selectedMode) {
  let config = await exists(settingsPath) ? await readJson(settingsPath) : { port: 19877, token: randomBytes(32).toString('hex') };
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token || '')) throw new Error('Invalid local translator settings');
  config = { ...config, schemaVersion: 2, mode: configurationMode(config, selectedMode) };
  await writeJson(settingsPath, config);
  return config;
}

export function operation(config, route, method = 'GET', body) {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: config.port, path: route, method,
      headers: { 'x-local-token': config.token, 'Content-Type': 'application/json', ...(data && { 'Content-Length': data.length }) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; if (text.length > 500000) response.destroy(new Error('Local response too large')); });
      response.on('error', reject);
      response.on('end', () => {
        try { const result = JSON.parse(text); if (response.statusCode !== 200) throw new Error(result.error || `Local HTTP ${response.statusCode}`); resolve(result); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(route === '/status' ? 2000 : 180000, () => request.destroy(new Error('Local translator timed out')));
    request.on('error', reject); request.end(data);
  });
}

export async function startService(config, { inline = false } = {}) {
  let existing;
  try { existing = await operation(config, '/status'); } catch { /* service is not running */ }
  if (existing?.version === version && existing.mode === config.mode && (config.mode !== 'api' || existing.apiConfigurationId === apiConfigurationId())) return { started: false };
  if (existing?.service === 'claude-offline-translator') {
    if (existing.active) throw new Error('Translation is still active. Wait for it to finish before changing mode.');
    await operation(config, '/shutdown', 'POST'); await delay(300);
  }
  if (inline) {
    const owned = await runService(config, version);
    ownedServices.set(config.port, owned);
    owned.server.once('close', () => ownedServices.delete(config.port));
    return { started: true };
  }
  await mkdir(stateDirectory, { recursive: true });
  const log = await open(path.join(stateDirectory, 'offline-service.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'bin/offline.mjs'), 'serve', config.mode], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  let failure; child.on('error', error => { failure = error; }); child.unref(); await log.close();
  for (let attempt = 0; attempt < 240; attempt++) {
    if (failure || child.exitCode !== null) throw new Error(`Translator could not start. See ${path.join(stateDirectory, 'offline-service.log')}`);
    try { const info = await operation(config, '/status'); if (info.version === version && info.mode === config.mode) return { started: true }; } catch { /* starting */ }
    await delay(250);
  }
  throw new Error(`Translator startup timed out. See ${path.join(stateDirectory, 'offline-service.log')}`);
}

export async function closeOwnedServices() {
  await Promise.all([...ownedServices.values()].map(({ server }) => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); })));
}

export async function openCompanion(config, { launchClaude = false, ownerPid = 0, ownerLease = '', inlineService = false, report = () => {} } = {}) {
  if (process.platform !== 'win32') throw new Error('The translation companion supports Windows only.');
  report('Starting local service');
  await startService(config, { inline: inlineService });
  report('Local service ready; opening companion');
  if (launchClaude) {
    const executable = path.join(homedir(), 'AppData/Local/AnthropicClaude/claude.exe');
    const app = spawn(executable, ['--force-renderer-accessibility'], { detached: true, windowsHide: true, stdio: 'ignore' });
    app.on('error', () => {}); app.unref();
  }
  const bridgeLog = path.join(stateDirectory, 'desktop-bridge.log');
  const args = companionCommand({ script: path.join(root, 'windows/start-bridge.ps1'), config: settingsPath, ownerPid, ownerLease, log: bridgeLog });
  // DETACHED_PROCESS makes Windows PowerShell exit 0 without executing its
  // command on this host. Keep a normal process and unref only standalone runs.
  const child = spawnPowerShell(args);
  child.stdout.on('data', chunk => appendFile(bridgeLog, chunk).catch(() => {}));
  child.stderr.on('data', chunk => appendFile(bridgeLog, chunk).catch(() => {}));
  child.on('error', error => report(`Companion launch failed: ${error.message}`));
  child.once('exit', code => report(`Companion exited: ${code}`));
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  if (!ownerPid) { child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); }
  report(`Companion process started; pid=${child.pid}`);
  return { opened: true, mode: config.mode, version, requiresUnlockedDesktopForSending: true };
}
