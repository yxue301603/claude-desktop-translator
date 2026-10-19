#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createExtensionServer } from '../src/extension-server.mjs';
import { settings, stateDirectory, closeOwnedServices } from '../src/desktop-controller.mjs';
import { appendFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

try {
  const config = await settings(process.env.CDT_TRANSLATION_MODE || (process.env.CDT_OFFLINE_MODE === 'true' ? 'offline' : 'account'));
  const ownerLease = path.join(stateDirectory, `extension-owner-${randomUUID()}.pid`);
  await writeFile(ownerLease, String(process.pid), { mode: 0o600 });
  const report = message => { process.stderr.write(`Translator startup: ${message}\n`); appendFile(path.join(stateDirectory, 'extension-startup.log'), `${new Date().toISOString()} ${message}\n`).catch(() => {}); };
  const server = createExtensionServer({ config, ownerLease, autoStart: process.env.CDT_AUTO_START !== 'false' && process.env.CDT_MANUAL_START !== 'true', report });
  report(`Extension loaded; pid=${process.pid}; runtime=${process.execPath}`);
  await server.connect(new StdioServerTransport());
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await rm(ownerLease, { force: true }); await closeOwnedServices(); await server.close(); };
  server.onclose = close;
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.once('SIGTERM', close); process.once('SIGINT', close);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
