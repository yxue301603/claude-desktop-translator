import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { prepareAccountRequest, extractAccountResponse } from './account-workflow.mjs';
import { prepareEnglishSubmission } from './submission.mjs';

export function createOfflineService({ token, translator, mode = 'offline', version = '0.3.1' }) {
  if (!['api', 'account', 'offline'].includes(mode)) throw new Error('Unknown translation mode');
  if (mode !== 'account' && !translator) throw new Error('Selected mode needs a translator');
  const metrics = { en: 0, zh: 0, active: 0, failures: 0 };
  const server = http.createServer(async (request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    if (request.headers.origin || !['127.0.0.1', 'localhost'].includes(request.headers.host?.split(':')[0])) return json(403, { error: 'Local application requests only' });
    const candidate = Buffer.from(request.headers['x-local-token'] || '');
    const expected = Buffer.from(token);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return json(401, { error: 'Unauthorized local request' });
    if (request.method === 'GET' && request.url === '/status') return json(200, { service: 'claude-offline-translator', version, mode, englishOnly: mode !== 'account', apiConfigured: mode === 'api' ? translator.configured : undefined, apiConfigurationId: mode === 'api' ? translator.configurationId : undefined, offline: mode === 'offline', model: translator?.model || 'signed-in-claude-desktop', ...metrics });
    if (request.method === 'POST' && request.url === '/shutdown') {
      if (metrics.active) return json(409, { error: 'Translations are still active' });
      json(200, { stopped: true }); server.close(); server.closeIdleConnections(); return;
    }
    if (request.method !== 'POST' || !['/translate', '/prepare', '/extract'].includes(request.url)) return json(404, { error: 'No such local operation' });
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > (request.url === '/extract' ? 600000 : 160000)) return json(413, { error: 'Text is too large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (typeof body.text !== 'string' || body.text.length > (request.url === '/extract' ? 150000 : 30000)) return json(400, { error: 'Invalid text' });
      if (request.url === '/prepare') {
        metrics.active++;
        try { return json(200, mode === 'account' ? prepareAccountRequest(body.text) : await prepareEnglishSubmission(translator, body.text)); }
        catch (error) { return json(400, { error: error.message }); }
        finally { metrics.active--; }
      }
      if (request.url === '/extract') {
        try { return json(200, extractAccountResponse(body.text)); }
        catch (error) { return json(422, { error: error.message }); }
      }
      if (mode === 'account') return json(409, { error: 'Legacy account mode only extracts marked bilingual answers. Choose api or offline to translate arbitrary outputs.' });
      if (!['en', 'zh'].includes(body.target)) return json(400, { error: 'Invalid translation direction' });
      metrics.active++;
      try {
        const text = await translator.translate(body.text, body.target);
        metrics[body.target]++;
        json(200, { text });
      } finally { metrics.active--; }
    } catch (error) {
      metrics.failures++;
      if (!response.destroyed) json(500, { error: mode === 'api' ? error.message : 'Local translation failed or did not preserve the complete text. Run npm run doctor to inspect the local runtime.' });
    }
  });
  return { server, metrics };
}
