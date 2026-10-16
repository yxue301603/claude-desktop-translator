import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function createOfflineService({ token, translator }) {
  const metrics = { en: 0, zh: 0, active: 0, failures: 0 };
  const server = http.createServer(async (request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    if (request.headers.origin || !['127.0.0.1', 'localhost'].includes(request.headers.host?.split(':')[0])) return json(403, { error: 'Local application requests only' });
    const candidate = Buffer.from(request.headers['x-local-token'] || '');
    const expected = Buffer.from(token);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return json(401, { error: 'Unauthorized local request' });
    if (request.method === 'GET' && request.url === '/status') return json(200, { service: 'claude-offline-translator', offline: true, model: translator.model, ...metrics });
    if (request.method === 'POST' && request.url === '/shutdown') {
      if (metrics.active) return json(409, { error: 'Translations are still active' });
      json(200, { stopped: true }); server.close(); server.closeIdleConnections(); return;
    }
    if (request.method !== 'POST' || request.url !== '/translate') return json(404, { error: 'No such local operation' });
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 160000) return json(413, { error: 'Text is too large' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (!['en', 'zh'].includes(body.target) || typeof body.text !== 'string' || body.text.length > 30000) return json(400, { error: 'Invalid text or translation direction' });
      metrics.active++;
      try {
        const text = await translator.translate(body.text, body.target);
        metrics[body.target]++;
        json(200, { text });
      } finally { metrics.active--; }
    } catch {
      metrics.failures++;
      if (!response.destroyed) json(500, { error: 'Local translation failed or did not preserve the complete text. Run npm run doctor to inspect the local runtime.' });
    }
  });
  return { server, metrics };
}
