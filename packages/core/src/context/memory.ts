import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJson, writeJsonAtomic, atomicWrite } from '../util/fs';
import { ensureDir } from '../util/fs';
import { shortId } from '../util/ids';
import { redactSecrets } from '../util/redact';

export type MemoryKind = 'decision' | 'unfinished' | 'known-issue' | 'fact' | 'session-summary';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  files?: string[];
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
}

interface MemoryFile {
  version: 1;
  entries: MemoryEntry[];
}

export class MemoryStore {
  private readonly root: string;
  private readonly file: string;
  private readonly markdown: string;
  private maxEntries: number;

  constructor(root: string, maxEntries = 80) {
    this.root = root;
    this.file = path.join(root, '.mookacode', 'memory.json');
    this.markdown = path.join(root, '.mookacode', 'MEMORY.md');
    this.maxEntries = maxEntries;
  }

  setMaxEntries(value: number): void {
    this.maxEntries = Math.max(1, value);
  }

  async load(): Promise<MemoryEntry[]> {
    const data = await readJson<MemoryFile>(this.file);
    return data?.entries ?? [];
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
    const entries = await this.load();
    const text = redactSecrets(entry.text.trim()).slice(0, 2000);
    if (!text) throw new Error('Memory entry cannot be empty');
    const normalized = text.toLowerCase();
    const existing = entries.find(
      (item) =>
        item.kind === entry.kind &&
        (item.text.toLowerCase() === normalized ||
          (entry.sessionId && item.sessionId === entry.sessionId && item.kind === 'session-summary')),
    );
    if (existing) {
      existing.text = text;
      existing.files = entry.files;
      existing.updatedAt = Date.now();
      await this.save(entries);
      return existing;
    }
    const created: MemoryEntry = {
      ...entry,
      text,
      files: entry.files?.map((file) => file.split(path.sep).join('/')),
      id: shortId('mem'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    entries.unshift(created);
    await this.save(entries);
    return created;
  }

  async remove(id: string): Promise<boolean> {
    const entries = await this.load();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    await this.save(next);
    return true;
  }

  async relevant(query: string, limit = 8): Promise<MemoryEntry[]> {
    const entries = await this.load();
    if (!entries.length) return [];
    const terms = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_\u0400-\u04ff]+/i)
        .filter((term) => term.length > 2)
        .slice(0, 30),
    );
    const scored = entries.map((entry) => {
      const haystack = `${entry.kind} ${entry.text} ${(entry.files ?? []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 2;
      if (entry.kind === 'known-issue' || entry.kind === 'unfinished') score += 1;
      if (entry.kind === 'decision') score += 1;
      score += Math.max(0, 1 - (Date.now() - entry.updatedAt) / (30 * 24 * 60 * 60_000));
      return { entry, score };
    });
    return scored
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    const bounded = this.prune(entries).slice(0, this.maxEntries);
    await writeJsonAtomic(this.file, { version: 1, entries: bounded } satisfies MemoryFile, 0o600);
    await ensureDir(path.dirname(this.markdown));
    const lines = [
      '# MookaCode project memory',
      '',
      'This file is generated. Structured entries live in memory.json.',
      '',
    ];
    for (const kind of ['decision', 'unfinished', 'known-issue', 'fact', 'session-summary'] as MemoryKind[]) {
      const group = bounded.filter((entry) => entry.kind === kind);
      if (!group.length) continue;
      lines.push(`## ${kind}`, '');
      for (const entry of group) {
        const files = entry.files?.length ? ` _(${entry.files.join(', ')})_` : '';
        lines.push(`- ${entry.text}${files}`);
      }
      lines.push('');
    }
    await atomicWrite(this.markdown, lines.join('\n'));
  }

  private prune(entries: MemoryEntry[]): MemoryEntry[] {
    if (entries.length <= this.maxEntries) return entries;
    const keep: MemoryEntry[] = [];
    const summaries = entries
      .filter((entry) => entry.kind === 'session-summary')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const important = entries.filter((entry) => entry.kind !== 'session-summary');
    keep.push(...important);
    const room = Math.max(0, this.maxEntries - important.length);
    keep.push(...summaries.slice(0, room));
    return keep;
  }

  async readGeneratedNotes(): Promise<string> {
    try {
      const content = await readFile(this.markdown, 'utf8');
      return content.slice(0, 12_000);
    } catch {
      return '';
    }
  }
}
