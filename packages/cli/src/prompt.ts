import { createInterface, type Interface } from 'node:readline';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionRequest, PermissionResponse } from '@mookacode/protocol';
import { mookaHome } from '@mookacode/core';
import { theme, icons, truncate } from './theme';
import { CancelledError } from '@mookacode/core';

const SLASH_COMMANDS = [
  '/help',
  '/pet',
  '/effort',
  '/new',
  '/model',
  '/provider',
  '/mode',
  '/models',
  '/sessions',
  '/resume',
  '/continue',
  '/diff',
  '/status',
  '/permissions',
  '/compact',
  '/init',
  '/clear',
  '/quit',
  '/exit',
];

function historyFile(): string {
  return path.join(mookaHome(), 'history');
}

function loadHistory(): string[] {
  try {
    return readFileSync(historyFile(), 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000).reverse();
  } catch {
    return [];
  }
}

export class PromptSession {
  readonly rl: Interface;
  readonly interactive: boolean;
  private closed = false;

  constructor() {
    this.interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    mkdirSync(mookaHome(), { recursive: true });
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.interactive,
      history: loadHistory(),
      historySize: 1000,
      removeHistoryDuplicates: true,
      completer: (line: string) => {
        if (!line.startsWith('/')) return [[], line];
        const hits = SLASH_COMMANDS.filter((command) => command.startsWith(line));
        return [hits.length ? hits : SLASH_COMMANDS, line];
      },
    });
  }

  async question(prompt: string): Promise<string> {
    if (this.closed) return '';
    if (!this.interactive) return '';
    return new Promise<string>((resolve, reject) => {
      const onSigint = () => {
        this.rl.removeListener('SIGINT', onSigint);
        reject(new CancelledError());
      };
      this.rl.once('SIGINT', onSigint);
      this.rl.question(prompt, (answer) => {
        this.rl.removeListener('SIGINT', onSigint);
        try {
          appendFileSync(historyFile(), `${answer.replace(/\n/g, ' ')}\n`, { mode: 0o600 });
        } catch {
          // History is optional.
        }
        resolve(answer);
      });
    });
  }

  async confirmPermission(request: PermissionRequest): Promise<PermissionResponse> {
    if (!this.interactive) {
      return {
        id: request.id,
        approved: false,
        reason: 'No interactive terminal is available for permission approval.',
      };
    }
    const lines: string[] = [];
    lines.push('');
    lines.push(`${icons.warn} ${theme.bold('Permission required')} ${theme.gray(`[${request.risk.level}]`)}`);
    lines.push(`  ${request.title}`);
    lines.push(`  ${theme.gray(request.detail)}`);
    if (request.command) lines.push(`  ${theme.cyan('$')} ${request.command}`);
    if (request.paths?.length) lines.push(`  ${theme.gray('paths:')} ${request.paths.join(', ')}`);
    if (request.preview) {
      const preview = request.preview
        .split('\n')
        .slice(0, 16)
        .map((line) => `    ${line}`)
        .join('\n');
      lines.push(theme.gray('  preview:'));
      lines.push(theme.gray(preview));
    }
    lines.push(`  ${theme.gray('Risk:')} ${request.risk.reason}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    const answer = (await this.question(`  Allow? [${theme.bold('y')}]es / [n]o / [a]lways for this tool: `))
      .trim()
      .toLowerCase();
    if (answer === 'a' || answer === 'always') {
      return { id: request.id, approved: true, alwaysAllow: true, rememberTool: true };
    }
    if (answer === 'y' || answer === 'yes') return { id: request.id, approved: true };
    return { id: request.id, approved: false, reason: 'Denied by user' };
  }

  async choose(title: string, labels: string[], defaultIndex = 0): Promise<number> {
    if (!this.interactive) return defaultIndex;
    process.stdout.write(`\n${theme.bold(title)}\n`);
    labels.forEach((label, index) => {
      process.stdout.write(`  ${index + 1}. ${label}\n`);
    });
    const answer = (await this.question(`  Choose [1-${labels.length}] (${defaultIndex + 1}): `)).trim();
    const parsed = Number.parseInt(answer || String(defaultIndex + 1), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > labels.length) return defaultIndex;
    return parsed - 1;
  }

  async askYesNo(title: string, defaultValue = false): Promise<boolean> {
    if (!this.interactive) return defaultValue;
    const answer = (await this.question(`${title} [${defaultValue ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === 'y' || answer === 'yes';
  }

  print(text = ''): void {
    process.stdout.write(`${text}\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    process.stdout.write('\u001b[?25h');
  }
}

export async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('Cannot read a secret from a non-interactive terminal.');
  }
  process.stdout.write(label);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new CancelledError());
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char === '\u0016') continue;
        value += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export function writeLines(lines: string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function shortPath(value: string, width = 46): string {
  if (value.length <= width) return value;
  return `…${truncate(value, width - 1).slice(1)}`;
}

export function clearScreen(): void {
  process.stdout.write('\u001b[2J\u001b[H');
}

export function writeHistoryLine(line: string): void {
  try {
    mkdirSync(mookaHome(), { recursive: true });
    appendFileSync(historyFile(), `${line}\n`, { mode: 0o600 });
  } catch {
    // ignore
  }
}

export function resetHistory(): void {
  try {
    writeFileSync(historyFile(), '', { mode: 0o600 });
  } catch {
    // ignore
  }
}
