import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { OfflineTranslator, modelId } from '../src/offline-engine.mjs';
import { writeJson } from '../src/config.mjs';

const cases = JSON.parse(await readFile(new URL('../test/fixtures/accuracy.json', import.meta.url), 'utf8'));
if (process.argv.includes('--long')) cases.push(JSON.parse(await readFile(new URL('../test/fixtures/long-context.json', import.meta.url), 'utf8')));
const translator = new OfflineTranslator();
const results = [];
try {
  for (const item of cases) {
    const start = performance.now();
    try {
      const translation = await translator.translate(item.source, item.target);
      const literalCheck = item.literals.every(value => translation.includes(value));
      const result = { ...item, translation, literalCheck, milliseconds: Math.round(performance.now() - start), semanticReview: 'pending' };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) { results.push({ ...item, error: error.message, semanticReview: 'failed' }); console.log(JSON.stringify({ id: item.id, error: error.message })); }
    await writeJson('.local/accuracy-results.json', { model: modelId, generatedAt: new Date().toISOString(), results });
  }
  if (results.some(item => item.error || !item.literalCheck)) process.exitCode = 1;
  console.log('Semantic accuracy must be reviewed against each case meaning; literal checks alone are not an accuracy score.');
} finally { await translator.dispose(); }
