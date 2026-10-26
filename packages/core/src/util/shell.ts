import { spawn, type ChildProcess } from 'node:child_process';
import { CancelledError } from './errors';
import { sanitizeTerminalOutput } from './ansi';

export interface CommandSpec {
  command: string;
  cwd: string;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputChars?: number;
  detached?: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  truncated: boolean;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 60_000;

function resolveShell(shell?: string): { file: string; args: string[] } {
  const configured = shell?.trim();
  if (process.platform === 'win32') {
    if (configured) return { file: configured, args: ['/d', '/s', '/c'] };
    const comspec = process.env.ComSpec || 'cmd.exe';
    if (/pwsh|powershell/i.test(comspec)) return { file: comspec, args: ['-NoLogo', '-NoProfile', '-Command'] };
    return { file: comspec, args: ['/d', '/s', '/c'] };
  }
  const file = configured || process.env.SHELL || '/bin/sh';
  return { file, args: ['-lc'] };
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 1500).unref();
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

export async function runShellCommand(spec: CommandSpec): Promise<CommandResult> {
  const started = Date.now();
  const shell = resolveShell(spec.shell);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT;
  const maxOutput = spec.maxOutputChars ?? DEFAULT_MAX_OUTPUT;

  return new Promise<CommandResult>((resolve, reject) => {
    if (spec.signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const child = spawn(shell.file, [...shell.args, spec.command], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, NO_COLOR: '1', CI: process.env.CI ?? '1' },
      windowsHide: true,
      detached: spec.detached ?? process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutput) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > maxOutput) {
        truncated = true;
        return next.slice(0, maxOutput);
      }
      return next;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      if (cancelled || spec.signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      resolve({
        stdout: sanitizeTerminalOutput(stdout),
        stderr: sanitizeTerminalOutput(stderr),
        exitCode,
        signal,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        truncated,
      });
    });
  });
}
