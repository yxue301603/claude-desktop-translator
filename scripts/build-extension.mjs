import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { packExtension, validateManifest } from '@anthropic-ai/mcpb';
import { root, version } from '../src/desktop-controller.mjs';

const exec = promisify(execFile);
const output = path.join(root, 'artifacts'); await mkdir(output, { recursive: true });
const stage = await mkdtemp(path.join(output, 'mcpb-build-'));
for (const file of ['manifest.json', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'src', 'bin', 'windows', 'docs'])
  await cp(path.join(root, file), path.join(stage, file), { recursive: true });
if (!validateManifest(path.join(stage, 'manifest.json'))) throw new Error('Invalid MCPB manifest');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Build with npm run build:extension so the npm CLI location is known.');
await exec(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, windowsHide: true, maxBuffer: 2000000 });
const name = `claude-desktop-translator-${version}.mcpb`;
const file = path.join(output, name);
if (!await packExtension({ extensionPath: stage, outputPath: file, silent: true })) throw new Error('MCPB packaging failed');
const bytes = await readFile(file);
const digest = createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(output, 'SHA256SUMS.txt'), `${digest}  ${name}\n`);
await writeFile(path.join(output, 'build-result.json'), JSON.stringify({ version, archive: file, stage, bytes: bytes.length, sha256: digest }, null, 2));
console.log(JSON.stringify({ version, archive: file, bytes: bytes.length, sha256: digest }, null, 2));
