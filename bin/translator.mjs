#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, loadConfig, exists } from '../src/config.mjs';
import { createGateway } from '../src/server.mjs';
import { setup, activateDesktop, restoreDesktop } from '../src/setup.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'help';
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const configFile = path.resolve(option('config', defaultConfigPath));
const cliPath = fileURLToPath(import.meta.url);

async function health(config, authenticated = false) {
  try {
    const result = await fetch(`http://127.0.0.1:${config.port}/${authenticated ? 'status' : 'healthz'}`, {
      signal: AbortSignal.timeout(2000), headers: authenticated ? { 'x-api-key': config.gatewayToken } : {},
    });
    if (!result.ok) return null;
    const body = await result.json();
    return authenticated || body.service === 'claude-desktop-translator' ? body : null;
  } catch { return null; }
}

async function start(config) {
  if (await health(config, true)) return;
  await mkdir(path.dirname(configFile), { recursive: true });
  const log = await open(path.join(path.dirname(configFile), 'gateway.log'), 'a');
  const child = spawn(process.execPath, [cliPath, 'serve', '--config', configFile], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  await log.close();
  for (let i = 0; i < 60; i++) {
    if (await health(config, true)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Gateway did not start. Check gateway.log beside your local configuration.');
}

async function findDesktop() {
  if (option('claude-exe')) return option('claude-exe');
  if (process.platform === 'win32') {
    const file = path.join(homedir(), 'AppData', 'Local', 'AnthropicClaude', 'claude.exe');
    if (await exists(file)) return file;
  }
  if (process.platform === 'darwin') return '/Applications/Claude.app/Contents/MacOS/Claude';
  throw new Error('Use --claude-exe with the path to your Claude Desktop executable');
}

async function main() {
  if (command === 'help' || command === '--help') {
    console.log(`Claude Desktop Translator\n\nsetup [--upstream-model MODEL]  Import existing gateway credentials by reference\nserve                          Run the local translation gateway\nstart                          Start the gateway in the background\nlaunch                         Start the gateway and open Claude Desktop\nactivate-desktop               Add and select a separate translation profile\nrestore-desktop                Select your original desktop profile\ndoctor                         Check provider and translation connectivity\nstatus                         Show metadata-only service counters\nplugin-hook                    Start the configured gateway for a Claude plugin\n\nEvery command accepts --config PATH. No API keys are printed or copied into the source.`);
    return;
  }
  if (command === 'setup') {
    const config = await setup(configFile, { desktopRoot: option('desktop-root'), upstreamModel: option('upstream-model'), port: option('port', 19876) });
    console.log(`Configuration saved: ${configFile}\nUpstream: ${config.upstreamBaseUrl}\nModel: ${config.upstreamModel}\nRun doctor, then activate-desktop and launch.`);
    return;
  }
  if (command === 'activate-desktop') {
    const config = await loadConfig(configFile);
    if (!(await health(config, true))) throw new Error('Start the gateway before activating the desktop profile');
    console.log(JSON.stringify(await activateDesktop(configFile)));
    console.log('Fully quit and reopen Claude Desktop for the new profile to take effect.');
    return;
  }
  if (command === 'restore-desktop') { console.log(JSON.stringify(await restoreDesktop(configFile))); return; }
  if (command === 'plugin-hook' && !(await exists(configFile))) {
    console.error('Claude Translator: run setup and launch once before using this plugin.');
    console.log('{}');
    return;
  }
  const config = await loadConfig(configFile);
  if (command === 'serve') {
    const { server } = createGateway(config, { onAudit: event => console.log(JSON.stringify({ time: new Date().toISOString(), ...event })) });
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Gateway port already in use' : error.message); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => console.log(`Claude Translator listening on http://127.0.0.1:${config.port}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
  } else if (['start', 'launch', 'plugin-hook'].includes(command)) {
    await start(config);
    if (command === 'launch') {
      const child = spawn(await findDesktop(), [], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    console.log(command === 'plugin-hook' ? '{}' : `Gateway ready on 127.0.0.1:${config.port}`);
  } else if (command === 'status') {
    const status = await health(config, true);
    if (!status) throw new Error('Gateway is not running');
    console.log(JSON.stringify(status, null, 2));
  } else if (command === 'stop') {
    const response = await fetch(`http://127.0.0.1:${config.port}/shutdown`, { method: 'POST', headers: { 'x-api-key': config.gatewayToken }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Gateway refused shutdown: HTTP ${response.status}`);
    console.log('Gateway stopped.');
  } else if (command === 'doctor') {
    const { Translator } = await import('../src/translate.mjs');
    const translator = new Translator(config);
    const english = await translator.translate('请只回复一句话：翻译测试成功。保留 `npm test` 原样。', 'en');
    const chinese = await translator.translate('Translation test succeeded. Keep `npm test` unchanged.', 'zh');
    console.log(JSON.stringify({ upstream: config.upstreamBaseUrl, model: config.upstreamModel, english, chinese, literalsPreserved: english.includes('`npm test`') && chinese.includes('`npm test`'), gateway: Boolean(await health(config, true)) }, null, 2));
    if (!/\p{Script=Han}/u.test(chinese) || /\p{Script=Han}/u.test(english)) throw new Error('Provider did not complete bidirectional translation');
  } else throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Claude Translator: ${error.message}`);
  if (command === 'plugin-hook') console.log('{}');
  else process.exitCode = 1;
});
