import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uuid } from './ids';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${uuid()}.tmp`);
  await writeFile(temp, data, mode === undefined ? undefined : { mode });
  try {
    await rename(temp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    await writeFile(file, data);
    const { unlink } = await import('node:fs/promises');
    await unlink(temp).catch(() => undefined);
  }
  if (mode !== undefined) await chmod(file, mode).catch(() => undefined);
}

export async function writeJsonAtomic(file: string, value: unknown, mode?: number): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function fileSha256(file: string): Promise<string> {
  return sha256(await readFile(file));
}
