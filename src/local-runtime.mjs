import http from 'node:http';

export const modelId = 'hf.co/tencent/Hy-MT2-1.8B-GGUF:Q4_K_M';
const allowedRoutes = new Set(['/api/show', '/api/chat', '/api/generate', '/api/version']);

export class LocalRuntime {
  constructor({ port = 11434, transport = http.request } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local runtime port');
    this.port = port;
    this.transport = transport;
  }

  post(route, body, timeout = 180000) {
    if (!allowedRoutes.has(route)) return Promise.reject(new Error('Unsupported local runtime operation'));
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = this.transport({ hostname: '127.0.0.1', port: this.port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 2000000) response.destroy(new Error('Local runtime response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200 || result.error) throw new Error(result.error || `Local runtime HTTP ${response.statusCode}`);
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(timeout, () => request.destroy(new Error('Local translation timed out; original text was not submitted.')));
      request.on('error', reject);
      request.end(data);
    });
  }
}
