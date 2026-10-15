import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const stateDir = path.join(homedir(), '.claude-desktop-translator');
export const defaultConfigPath = process.env.CDT_CONFIG || path.join(stateDir, 'config.json');

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export function assertBaseUrl(value, label) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid ${label}`);
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${label} must use HTTPS except on loopback`);
  }
  return url.href.replace(/\/$/, '');
}

export async function loadConfig(file = defaultConfigPath) {
  const config = await readJson(file);
  config.upstreamBaseUrl = assertBaseUrl(config.upstreamBaseUrl, 'upstreamBaseUrl');
  config.port ??= 19876;
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid port');
  if (!config.gatewayToken || config.gatewayToken.length < 24) throw new Error('Missing gatewayToken (run setup)');
  config.translationModel ??= config.upstreamModel;
  config.requestTimeoutMs ??= 180000;
  config.translationTimeoutMs ??= 60000;
  if (!config.translationModel) throw new Error('Missing translationModel');
  // Credentials stay in the user's existing provider configuration, outside this repository.
  if (config.credentialFile) {
    const credential = await readJson(config.credentialFile);
    config.upstreamApiKey = credential.inferenceGatewayApiKey || credential.env?.ANTHROPIC_AUTH_TOKEN || credential.env?.ANTHROPIC_API_KEY;
  }
  config.upstreamApiKey ||= process.env.CDT_UPSTREAM_API_KEY;
  if (!config.upstreamApiKey) throw new Error('No upstream API credential found');
  config.translationBaseUrl = assertBaseUrl(config.translationBaseUrl || config.upstreamBaseUrl, 'translationBaseUrl');
  config.translationApiKey = process.env.CDT_TRANSLATION_API_KEY || config.upstreamApiKey;
  return config;
}

export function apiUrl(base, pathname) {
  // Providers often have a prefix, e.g. https://api.deepseek.com/anthropic.
  return `${base.replace(/\/$/, '')}${pathname}`;
}
