import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
export async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}
