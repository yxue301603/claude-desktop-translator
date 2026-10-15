import path from 'node:path';
import { homedir } from 'node:os';
import { exists, readJson, writeJson } from './config.mjs';

export async function useOfficialAccount({ profileRoot, stateRoot } = {}) {
  if (process.platform !== 'win32' && !profileRoot) return { changed: false };
  const profile = profileRoot || path.join(homedir(), 'AppData', 'Local', 'Claude-3p');
  const file = path.join(profile, 'claude_desktop_config.json');
  if (!(await exists(file))) return { changed: false };
  const current = await readJson(file);
  if (current.deploymentMode !== '3p') return { changed: false };
  const backup = path.join(stateRoot || path.join(homedir(), '.claude-desktop-translator'), 'before-official-account.json');
  if (!(await exists(backup))) await writeJson(backup, current);
  await writeJson(file, { ...current, deploymentMode: '1p' });
  return { changed: true, restartRequired: true };
}
