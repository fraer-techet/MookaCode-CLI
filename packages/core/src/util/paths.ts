import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function homeDirectory(): string {
  return process.env.MOOKACODE_HOME_CONFIG_DIR ? path.resolve(process.env.MOOKACODE_HOME_CONFIG_DIR) : homedir();
}

export function mookaHome(): string {
  const override = process.env.MOOKACODE_HOME;
  return path.resolve(override && override.trim() ? override : path.join(homedir(), '.mookacode'));
}

export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2));
  return input;
}

export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function safeRealpath(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export function displayPath(root: string, target: string): string {
  const rel = path.relative(root, target);
  if (!rel) return '.';
  return toPosix(rel);
}
