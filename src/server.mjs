import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { Translator, translateRequest, translateResponse } from './translate.mjs';
import { translateSse, encodeEvent } from './sse.mjs';
import { apiUrl } from './config.mjs';

const MAX_BODY = 32 * 1024 * 1024;
function equalToken(candidate, expected) {
  const a = Buffer.from(candidate || '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorized(request, config) {
  return equalToken(request.headers['x-api-key'], config.gatewayToken) ||
    equalToken(request.headers.authorization?.replace(/^Bearer /i, ''), config.gatewayToken);
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

export function createGateway(config, { translator = new Translator(config), fetchImpl = fetch, onAudit = () => {} } = {}) {
  const metrics = { requests: 0, completed: 0, errors: 0, active: 0 };
  const server = http.createServer(async (request, response) => {
    // No CORS: browser pages cannot spend the user's API key through this loopback service.
    if (request.headers.origin) return json(response, 403, { error: { type: 'permission_error', message: 'Browser origins are not allowed' } });
    const hostname = request.headers.host?.split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(hostname)) return json(response, 403, { error: { message: 'Invalid Host' } });
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return json(response, 200, { service: 'claude-desktop-translator', version: '0.1.0' });
    }
    if (!authorized(request, config)) return json(response, 401, { error: { type: 'authentication_error', message: 'Invalid local gateway credential' } });
    if (url.pathname === '/shutdown' && request.method === 'POST') {
      if (metrics.active) return json(response, 409, { error: { message: 'Requests are still active' } });
      json(response, 200, { stopped: true });
      server.close();
      server.closeIdleConnections();
      return;
    }
    if (url.pathname === '/status' && request.method === 'GET') return json(response, 200, { ...metrics, translations: translator.metrics });
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      const data = (config.modelAliases || [config.upstreamModel]).filter(Boolean).map(id => ({ id, type: 'model', display_name: `${config.upstreamModel || id} · 中英翻译`, created_at: '2026-01-01T00:00:00Z' }));
      return json(response, 200, { data, has_more: false, first_id: data[0]?.id, last_id: data.at(-1)?.id });
    }
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(url.pathname)) {
      return json(response, 404, { error: { type: 'not_found_error', message: 'Unknown gateway endpoint' } });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.requestTimeoutMs)]);
    request.on('aborted', () => controller.abort());
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    metrics.requests++;
    metrics.active++;
    let heartbeat;
    try {
      const input = await readBody(request);
      if (!Array.isArray(input.messages) || !input.model) throw Object.assign(new Error('model and messages are required'), { status: 400 });
      const body = await translateRequest(input, translator, signal);
      if (config.upstreamModel) body.model = config.upstreamModel;
      // Metadata-only audit callback. Prompt and answer contents are never logged by the server.
      onAudit({ event: 'request_translated', model: body.model, userBlocks: body.messages.filter(message => message.role === 'user').length });
      const headers = {
        'Content-Type': 'application/json', 'anthropic-version': request.headers['anthropic-version'] || '2023-06-01',
        'Authorization': `Bearer ${config.upstreamApiKey}`, 'x-api-key': config.upstreamApiKey,
      };
      if (request.headers['anthropic-beta']) headers['anthropic-beta'] = request.headers['anthropic-beta'];
      const upstream = await fetchImpl(apiUrl(config.upstreamBaseUrl, `${url.pathname}${url.search}`), {
        method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'error',
      });
      if (!upstream.ok) {
        // Do not echo provider diagnostics that might include credentials or prompt contents.
        throw Object.assign(new Error(`Upstream provider returned HTTP ${upstream.status}`), { status: upstream.status });
      }
      const outputTranslator = body.output_config?.format || body.response_format
        ? { translate: async text => text }
        : translator;
      if (url.pathname.endsWith('/count_tokens')) {
        json(response, 200, await upstream.json());
      } else if (input.stream && upstream.headers.get('content-type')?.includes('text/event-stream')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        heartbeat = setInterval(() => response.write(': translating\n\n'), 10000);
        for await (const frame of translateSse(upstream.body, outputTranslator, signal)) {
          if (response.destroyed) break;
          if (!response.write(frame)) await once(response, 'drain', { signal });
        }
        response.end();
      } else {
        json(response, 200, await translateResponse(await upstream.json(), outputTranslator, signal));
      }
      metrics.completed++;
      onAudit({ event: 'request_completed' });
    } catch (error) {
      metrics.errors++;
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      const message = signal.aborted ? 'Request cancelled or timed out' : error.message;
      onAudit({ event: 'request_error', status });
      if (!response.destroyed) {
        const payload = { type: 'error', error: { type: 'api_error', message } };
        if (response.headersSent) response.end(encodeEvent(payload));
        else json(response, status, payload);
      }
    } finally {
      clearInterval(heartbeat);
      metrics.active--;
    }
  });
  server.requestTimeout = config.requestTimeoutMs;
  return { server, translator, metrics };
}
