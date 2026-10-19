import { OfflineTranslator } from './offline-engine.mjs';
import { ensureRuntime } from './ollama-process.mjs';
import { createOfflineService } from './offline-service.mjs';

export async function runService(config, version) {
  let translator;
  if (config.mode === 'offline') {
    await ensureRuntime(); translator = new OfflineTranslator(); await translator.load('en'); await translator.load('zh');
  }
  const { server, metrics } = createOfflineService({ token: config.token, translator, mode: config.mode, version });
  server.on('close', () => translator?.dispose());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { server, metrics };
}
