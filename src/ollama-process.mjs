import http from 'node:http';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

function running() {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port: 11434, path: '/api/version' }, response => { response.resume(); resolve(response.statusCode === 200); });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export async function ensureRuntime() {
  if (await running()) return;
  const executable = process.platform === 'win32' ? path.join(homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe') : 'ollama';
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['serve'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Install Ollama, start its local runtime, then run npm run models.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  for (let attempt = 0; attempt < 60; attempt++) { if (await running()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error('Ollama did not start at 127.0.0.1:11434. Start it locally and try again.');
}
