import { open, opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { isWithin, toPosix } from '../util/paths';

export interface WalkOptions {
  root: string;
  start?: string;
  maxEntries?: number;
  maxDepth?: number;
  ignoreDirectories?: string[];
  signal?: AbortSignal;
  includeDirectories?: boolean;
}

export interface FileEntry {
  path: string;
  absolute: string;
  name: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
}

function isProbablyBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 8000);
  for (let index = 0; index < length; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export async function isBinaryFile(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return isProbablyBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function prefixIgnorePatterns(patterns: string[], base: string): string[] {
  if (!base) return patterns;
  const result: string[] = [];
  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    const cleaned = pattern.startsWith('/') ? pattern.slice(1) : pattern;
    const bases = cleaned.includes('/') ? [cleaned] : [cleaned, `**/${cleaned}`];
    for (const candidate of bases) result.push(`${negated ? '!' : ''}${base}/${candidate}`);
  }
  return result;
}

async function readIgnorePatterns(directory: string): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of ['.gitignore', '.mookacodeignore']) {
    try {
      const content = await readFile(path.join(directory, name), 'utf8');
      patterns.push(...content.split(/\r?\n/));
    } catch {
      // Missing ignore file is expected.
    }
  }
  return patterns;
}

export async function loadIgnore(root: string, extraDirectories: string[] = []): Promise<Ignore> {
  const ig = ignore();
  ig.add(extraDirectories.map((dir) => `${dir.replace(/[\\/]+$/, '')}/`));
  ig.add(await readIgnorePatterns(root));
  return ig;
}

export async function* walkFiles(options: WalkOptions): AsyncGenerator<FileEntry> {
  const root = path.resolve(options.root);
  const start = options.start ? path.resolve(options.start) : root;
  if (!isWithin(root, start) && start !== root) return;
  const maxEntries = options.maxEntries ?? 5000;
  const maxDepth = options.maxDepth ?? 24;
  const rootPatterns = [
    ...(options.ignoreDirectories?.map((dir) => `${dir.replace(/[\\/]+$/, '')}/`) ?? []),
    ...(await readIgnorePatterns(root)),
  ];
  let count = 0;

  async function* visit(directory: string, depth: number, inherited: string[]): AsyncGenerator<FileEntry> {
    if (depth > maxDepth || count >= maxEntries) return;
    if (options.signal?.aborted) return;
    let dir;
    try {
      dir = await opendir(directory);
    } catch {
      return;
    }
    const relativeDirectory = toPosix(path.relative(root, directory));
    const localPatterns =
      directory === root
        ? inherited
        : [...inherited, ...prefixIgnorePatterns(await readIgnorePatterns(directory), relativeDirectory)];
    const ig = ignore().add(localPatterns);
    for await (const entry of dir) {
      if (count >= maxEntries || options.signal?.aborted) return;
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ig.ignores(`${relative}/`)) continue;
        if (options.includeDirectories) {
          count++;
          yield { path: relative, absolute, name: entry.name, size: 0, mtimeMs: 0, isDirectory: true };
        }
        yield* visit(absolute, depth + 1, localPatterns);
      } else if (entry.isFile()) {
        if (ig.ignores(relative)) continue;
        let info;
        try {
          info = await stat(absolute);
        } catch {
          continue;
        }
        count++;
        yield {
          path: relative,
          absolute,
          name: entry.name,
          size: info.size,
          mtimeMs: info.mtimeMs,
          isDirectory: false,
        };
      }
    }
  }

  const startInfo = await stat(start).catch(() => null);
  if (!startInfo) return;
  if (startInfo.isFile()) {
    yield {
      path: toPosix(path.relative(root, start)),
      absolute: start,
      name: path.basename(start),
      size: startInfo.size,
      mtimeMs: startInfo.mtimeMs,
      isDirectory: false,
    };
    return;
  }
  yield* visit(start, 0, rootPatterns);
}

export async function readTextFileLimited(
  file: string,
  maxBytes = 2_000_000,
): Promise<{ content: string; size: number; binary: boolean }> {
  const info = await stat(file);
  if (info.size > maxBytes) {
    throw new Error(
      `File is too large to read safely (${info.size} bytes, limit ${maxBytes}). Read it in smaller parts or use search.`,
    );
  }
  const buffer = await readFile(file);
  if (isProbablyBinary(buffer)) return { content: '', size: info.size, binary: true };
  return { content: buffer.toString('utf8'), size: info.size, binary: false };
}
