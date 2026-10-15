import path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { readJson, writeJson, exists } from './config.mjs';

export function desktopPaths(root) {
  const base = root || (process.platform === 'win32'
    ? path.join(homedir(), 'AppData', 'Local', 'Claude-3p')
    : process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support', 'Claude-3p')
      : path.join(homedir(), '.config', 'Claude-3p'));
  return { root: base, library: path.join(base, 'configLibrary'), meta: path.join(base, 'configLibrary', '_meta.json'), settings: path.join(base, 'claude_desktop_config.json') };
}

export async function setup(configPath, { desktopRoot, upstreamModel, port = 19876 } = {}) {
  if (await exists(configPath)) throw new Error(`Configuration already exists: ${configPath}. Use it or move it aside first.`);
  const desktop = desktopPaths(desktopRoot);
  let source;
  let credentialFile;
  let cli;
  try { cli = await readJson(path.join(homedir(), '.claude', 'settings.json')); } catch { /* optional */ }
  try {
    const meta = await readJson(desktop.meta);
    if (!/^[a-f0-9-]{36}$/i.test(meta.appliedId)) throw new Error('Invalid desktop profile ID');
    credentialFile = path.join(desktop.library, `${meta.appliedId}.json`);
    source = await readJson(credentialFile);
    if (source.inferenceProvider !== 'gateway') throw new Error('Only a gateway provider is supported');
    if (!source.inferenceGatewayApiKey) throw new Error('Desktop gateway has no static credential');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    credentialFile = path.join(homedir(), '.claude', 'settings.json');
    if (!cli?.env?.ANTHROPIC_BASE_URL) throw new Error('No existing desktop gateway or Claude Code API configuration. See README for manual setup.');
    source = { inferenceGatewayBaseUrl: cli.env.ANTHROPIC_BASE_URL };
  }
  const sameProvider = cli?.env?.ANTHROPIC_BASE_URL?.replace(/\/$/, '') === source.inferenceGatewayBaseUrl?.replace(/\/$/, '');
  const models = Array.isArray(source.inferenceModels) ? source.inferenceModels.map(model => model.name || model.id).filter(Boolean) : [];
  const model = upstreamModel || (sameProvider && (cli.env.ANTHROPIC_MODEL || cli.model)) || models[0];
  if (!model) throw new Error('Specify --upstream-model with a model served by your provider');
  const config = {
    port: Number(port), gatewayToken: randomBytes(32).toString('hex'),
    upstreamBaseUrl: source.inferenceGatewayBaseUrl,
    credentialFile, upstreamModel: model, translationModel: model,
    // Keep the desktop model routes as configured; upstreamModel is a separate routing choice.
    modelAliases: [...new Set(models.length ? models : [model])],
    translationTimeoutMs: 60000, requestTimeoutMs: 180000,
    desktopRoot: desktop.root,
  };
  await writeJson(configPath, config);
  return config;
}

export async function activateDesktop(configPath, { desktopRoot } = {}) {
  const config = await readJson(configPath);
  const desktop = desktopPaths(desktopRoot || config.desktopRoot);
  const meta = await readJson(desktop.meta);
  const originalId = meta.appliedId === config.desktopProfileId ? config.previousDesktopProfileId : meta.appliedId;
  if (!/^[a-f0-9-]{36}$/i.test(originalId)) throw new Error('Invalid desktop profile ID');
  const currentFile = path.join(desktop.library, `${originalId}.json`);
  const original = await readJson(currentFile);
  if (original.inferenceProvider !== 'gateway') throw new Error('Desktop must already use a gateway configuration');
  // Back up exact originals once; keep the user's original profile and key untouched.
  const backupDir = path.join(path.dirname(configPath), 'desktop-backup');
  if (!(await exists(path.join(backupDir, '_meta.json')))) {
    await writeJson(path.join(backupDir, '_meta.json'), meta);
    if (await exists(desktop.settings)) await copyFile(desktop.settings, path.join(backupDir, 'claude_desktop_config.json'));
  }
  const id = config.desktopProfileId || randomUUID();
  const entry = { id, name: '中英自动翻译 · Claude Translator' };
  const profile = {
    ...original,
    inferenceGatewayBaseUrl: `http://127.0.0.1:${config.port}`,
    inferenceGatewayApiKey: config.gatewayToken,
    inferenceModels: config.modelAliases.map(name => ({ name })),
    modelDiscoveryEnabled: true,
  };
  await writeJson(path.join(desktop.library, `${id}.json`), profile);
  await writeJson(desktop.meta, { ...meta, appliedId: id, entries: [...meta.entries.filter(item => item.id !== id), entry] });
  let settings = {};
  if (await exists(desktop.settings)) settings = await readJson(desktop.settings);
  await writeJson(desktop.settings, { ...settings, deploymentMode: '3p' });
  await writeJson(configPath, { ...config, desktopProfileId: id, previousDesktopProfileId: config.previousDesktopProfileId || meta.appliedId });
  return entry;
}

export async function restoreDesktop(configPath) {
  const config = await readJson(configPath);
  const desktop = desktopPaths(config.desktopRoot);
  const meta = await readJson(desktop.meta);
  if (meta.appliedId !== config.desktopProfileId) return { restored: false, reason: 'Another profile is already active' };
  if (!meta.entries?.some(entry => entry.id === config.previousDesktopProfileId)) throw new Error('Original desktop profile no longer exists');
  await writeJson(desktop.meta, { ...meta, appliedId: config.previousDesktopProfileId });
  return { restored: true };
}
