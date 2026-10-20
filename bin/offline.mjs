#!/usr/bin/env node
import { settings, operation, startService, openCompanion, version } from '../src/desktop-controller.mjs';
import { runService } from '../src/service-runtime.mjs';
import { useOfficialAccount } from '../src/account-mode.mjs';

async function main() {
  const command = process.argv[2] || 'launch';
  const selected = ['api', 'account', 'offline'].includes(process.argv[3]) ? process.argv[3] : process.env.CDT_TRANSLATION_MODE;
  const config = await settings(selected);
  if (command === 'setup') console.log(JSON.stringify(await useOfficialAccount()));
  else if (command === 'serve') {
    const { server } = await runService(config, version);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    console.log(`Translator ready: ${config.mode}; no credentials are read by this service.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
  } else if (command === 'status') console.log(JSON.stringify(await operation(config, '/status'), null, 2));
  else if (command === 'stop') console.log(JSON.stringify(await operation(config, '/shutdown', 'POST')));
  else if (command === 'translate') {
    if (config.mode === 'account') throw new Error('Translate requires api or offline mode.');
    await startService(config); console.log(JSON.stringify(await operation(config, '/translate', 'POST', { target: process.argv[3], text: process.argv.slice(4).join(' ') })));
  } else if (command === 'launch') console.log(JSON.stringify(await openCompanion(config, { launchClaude: true })));
  else if (command === 'start') console.log(JSON.stringify(await startService(config)));
  else throw new Error('Commands: launch [api|offline|account], start [api|offline|account], serve, status, stop, translate en|zh TEXT');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
