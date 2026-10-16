import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { exists } from '../src/config.mjs';
import { LocalRuntime, modelId } from '../src/local-runtime.mjs';
import { ensureRuntime } from '../src/ollama-process.mjs';

// Official Hy-MT2-1.8B-Q4_K_M.gguf, pinned for reproducible local inference.
const digest = 'sha256:dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699';
const cache = path.join(process.env.OLLAMA_MODELS || path.join(homedir(), '.ollama', 'models'), 'blobs', digest.replace(':', '-'));
const base = 'http://127.0.0.1:11434';
async function importFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (`sha256:${hash.digest('hex')}` !== digest) throw new Error('Model checksum differs from the verified official Q4_K_M weights.');
  const head = await fetch(`${base}/api/blobs/${digest}`, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
  if (head.status !== 200) {
    const upload = await fetch(`${base}/api/blobs/${digest}`, { method: 'POST', body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(600000) });
    if (!upload.ok) throw new Error(`Local model import HTTP ${upload.status}`);
  }
  const response = await fetch(base + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelId, files: { 'Hy-MT2-1.8B-Q4_K_M.gguf': digest }, stream: false }), signal: AbortSignal.timeout(180000) });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error('Local model registration failed. Update Ollama and retry.');
  console.log('Verified official weights imported locally.');
}
async function main() {
  await ensureRuntime();
  const localFile = process.argv[2] === '--gguf' ? process.argv[3] : null;
  if (localFile) { await importFile(localFile); return; }
  try { await new LocalRuntime().post('/api/show', { model: modelId }); console.log('Offline translation model is already installed.'); return; } catch { /* first installation */ }
  if (await exists(cache)) { await importFile(cache); return; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200000);
  let cached = false, last = '';
  try {
    const response = await fetch(base + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelId, stream: true }), signal: controller.signal });
    if (!response.ok) throw new Error('Model download failed.');
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const item = JSON.parse(line);
        if (item.error) throw new Error('Model download failed. Check the local Ollama network/proxy settings.');
        const stage = item.total ? `Downloading: ${Math.floor(10 * (item.completed || 0) / item.total) * 10}%` : item.status;
        if (stage !== last) { console.log(stage); last = stage; }
        if (item.digest === digest && item.completed === item.total && await exists(cache)) { cached = true; break; }
      }
      if (cached) break;
    }
  } finally { clearTimeout(timeout); controller.abort(); }
  if (cached) await importFile(cache);
  await new LocalRuntime().post('/api/show', { model: modelId });
  console.log('Offline translation model ready. No download is performed during translation.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
