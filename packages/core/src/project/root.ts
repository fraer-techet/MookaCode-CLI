import { homedir } from 'node:os';
import path from 'node:path';
import { mookaHome, normalizeForCompare, pathExists } from '../util/paths';

function mookaHomes(): Set<string> {
  return new Set([
    normalizeForCompare(mookaHome()),
    normalizeForCompare(path.join(homedir(), '.mookacode')),
    normalizeForCompare(path.join(homedir(), '.config', 'mookacode')),
  ]);
}

export async function findProjectRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  const homes = mookaHomes();
  while (true) {
    if (await pathExists(path.join(current, '.git'))) return current;
    const marker = path.join(current, '.mookacode');
    if (!homes.has(normalizeForCompare(marker)) && (await pathExists(marker))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}
