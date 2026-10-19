import { spawn } from 'node:child_process';
import path from 'node:path';

// PowerShell literals are escaped independently of Windows argv quoting.
export const powershellLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";

export function companionCommand({ script, config, ownerPid = 0, ownerLease = '', log }) {
  if (!Number.isInteger(ownerPid) || ownerPid < 0) throw new Error('Invalid companion owner');
  const bootstrap = log ? `[IO.File]::AppendAllText(${powershellLiteral(log)}, 'Companion bootstrap reached' + [Environment]::NewLine); ` : '';
  const command = `$ErrorActionPreference='Stop'; ${bootstrap}& ${powershellLiteral(script)} -Config ${powershellLiteral(config)} -OwnerPid ${ownerPid} -OwnerLease ${powershellLiteral(ownerLease)}`;
  return ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}

export function spawnPowerShell(args) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // DETACHED_PROCESS exits successfully without running scripts on this host.
  return spawn(executable, args, { detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
