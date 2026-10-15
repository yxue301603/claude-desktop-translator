import { OfflineTranslator, modelCache, modelIds } from '../src/offline-engine.mjs';
const translator = new OfflineTranslator({ download: true });
try {
  for (const target of ['en', 'zh']) {
    console.log(`Downloading/loading ${modelIds[target]} into ${modelCache}`);
    await translator.load(target);
    console.log(`${target}: ready`);
  }
  console.log(JSON.stringify({ english: await translator.translate('你好，请只回答一句话。', 'en'), chinese: await translator.translate('Hello. The offline translation is ready.', 'zh') }));
} finally { await translator.dispose(); }
