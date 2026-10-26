import { randomBytes, randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function shortId(prefix = ''): string {
  const id = randomBytes(5).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

export function now(): number {
  return Date.now();
}
