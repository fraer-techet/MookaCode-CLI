import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mookaHome } from '../util/paths';
import { redactSecrets } from '../util/redact';

export interface LoadedInstructions {
  chunks: Array<{ source: string; content: string }>;
  text: string;
}

const MAX_PER_FILE = 16_000;
const MAX_TOTAL = 40_000;

export async function loadInstructions(projectRoot: string, configuredNames: string[]): Promise<LoadedInstructions> {
  const candidates: Array<{ source: string; file: string; global?: boolean }> = [];
  candidates.push({ source: 'global AGENTS.md', file: path.join(mookaHome(), 'AGENTS.md'), global: true });
  for (const name of configuredNames) {
    if (name.includes('..')) continue;
    candidates.push({ source: name, file: path.join(projectRoot, name) });
  }
  candidates.push({ source: '.mookacode/notes.md', file: path.join(projectRoot, '.mookacode', 'notes.md') });

  const chunks: Array<{ source: string; content: string }> = [];
  let total = 0;
  for (const candidate of candidates) {
    if (total >= MAX_TOTAL) break;
    try {
      const raw = await readFile(candidate.file, 'utf8');
      const content = redactSecrets(raw.trim()).slice(0, MAX_PER_FILE);
      if (!content) continue;
      chunks.push({ source: candidate.source, content });
      total += content.length;
    } catch {
      // Missing instruction file is expected.
    }
  }
  const text = chunks
    .map((chunk) => `### Instructions: ${chunk.source}\n${chunk.content}`)
    .join('\n\n')
    .slice(0, MAX_TOTAL);
  return { chunks, text };
}
