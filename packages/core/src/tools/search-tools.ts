import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import type { ToolResult } from '@mookacode/protocol';
import { walkFiles, readTextFileLimited } from '../workspace/walker';
import { formatBytes } from '../util/format';
import { defineTool, safeRisk } from './types';

const listSchema = z.object({
  path: z.string().optional().default('.').describe('Directory relative to workspace root'),
  depth: z.number().int().min(1).max(20).optional().default(3),
  limit: z.number().int().min(1).max(2000).optional().default(300),
  includeDirectories: z.boolean().optional().default(true),
});

export const listFilesTool = defineTool({
  name: 'list_files',
  description:
    'List files and directories in the workspace. Honors .gitignore and built-in heavy-directory exclusions. Use search_files for glob matching and search_text for content search.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: listSchema,
  risk: () => safeRisk('Lists project paths only.'),
  title: (input) => `List ${input.path}`,
  detail: (input) => `List files under ${input.path} to depth ${input.depth}.`,
  paths: (input) => [input.path],
  async execute(input, ctx): Promise<ToolResult> {
    const start = await ctx.guard.resolve(input.path, { mustExist: true });
    const info = await stat(start);
    if (!info.isDirectory()) throw new Error(`Not a directory: ${input.path}`);
    const rows: string[] = [];
    let truncated = false;
    for await (const entry of walkFiles({
      root: ctx.root,
      start,
      maxDepth: input.depth,
      maxEntries: input.limit + 1,
      ignoreDirectories: ctx.config.ignoreDirectories,
      signal: ctx.signal,
      includeDirectories: input.includeDirectories,
    })) {
      if (rows.length >= input.limit) {
        truncated = true;
        break;
      }
      if (entry.isDirectory) {
        rows.push(`${entry.path}/`);
      } else {
        rows.push(`${entry.path}  (${formatBytes(entry.size)})`);
      }
    }
    if (rows.length === 0) {
      return {
        ok: true,
        summary: `No files under ${input.path}`,
        content: `No entries found under ${input.path}.`,
        metadata: { count: 0 },
      };
    }
    rows.sort();
    return {
      ok: true,
      summary: `Listed ${rows.length}${truncated ? '+' : ''} entries under ${input.path}`,
      content: `${rows.join('\n')}${truncated ? `\n… results truncated at ${input.limit}` : ''}`,
      metadata: { count: rows.length, truncated },
    };
  },
});

const searchFilesSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, for example "**/*.ts" or "src/**/test*"'),
  path: z.string().optional().default('.').describe('Directory to search under'),
  limit: z.number().int().min(1).max(2000).optional().default(200),
});

export const searchFilesTool = defineTool({
  name: 'search_files',
  description: 'Find files by glob pattern. Honors .gitignore and heavy-directory exclusions.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: searchFilesSchema,
  risk: () => safeRisk('Searches project file names.'),
  title: (input) => `Find files ${input.pattern}`,
  detail: (input) => `Glob "${input.pattern}" under ${input.path}.`,
  paths: (input) => [input.path],
  async execute(input, ctx): Promise<ToolResult> {
    const start = await ctx.guard.resolve(input.path, { mustExist: true });
    const matches: string[] = [];
    let truncated = false;
    for await (const entry of walkFiles({
      root: ctx.root,
      start,
      maxDepth: 30,
      maxEntries: 20_000,
      ignoreDirectories: ctx.config.ignoreDirectories,
      signal: ctx.signal,
    })) {
      if (entry.isDirectory) continue;
      if (!minimatch(entry.path, input.pattern, { dot: true, matchBase: true, nocase: process.platform === 'win32' }))
        continue;
      matches.push(entry.path);
      if (matches.length >= input.limit) {
        truncated = true;
        break;
      }
    }
    return {
      ok: true,
      summary: `Found ${matches.length}${truncated ? '+' : ''} file(s)`,
      content: matches.length ? matches.join('\n') : `No files matched "${input.pattern}".`,
      metadata: { count: matches.length, truncated },
    };
  },
});

const searchTextSchema = z.object({
  query: z.string().min(1).describe('Text or regular expression to search for'),
  path: z.string().optional().default('.').describe('Directory or file to search'),
  regex: z.boolean().optional().default(false),
  caseSensitive: z.boolean().optional().default(false),
  maxResults: z.number().int().min(1).max(500).optional().default(80),
  contextLines: z.number().int().min(0).max(5).optional().default(0),
});

interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export const searchTextTool = defineTool({
  name: 'search_text',
  description:
    'Search file contents using ripgrep when available (fallback: bounded built-in scanner). Returns matching paths, lines and columns. Use this before reading large files.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: searchTextSchema,
  risk: () => safeRisk('Reads matching project text.'),
  title: (input) => `Search text "${input.query.slice(0, 40)}"`,
  detail: (input) => `${input.regex ? 'Regex' : 'Literal'} search under ${input.path}.`,
  paths: (input) => [input.path],
  async execute(input, ctx): Promise<ToolResult> {
    const start = await ctx.guard.resolve(input.path, { mustExist: true });
    let matches: SearchMatch[] = [];
    try {
      matches = await ripgrepSearch(input, start, ctx.root, ctx.signal);
    } catch {
      matches = await fallbackSearch(input, start, ctx.root, ctx.config.ignoreDirectories, ctx.signal);
    }
    if (matches.length === 0) {
      return { ok: true, summary: 'No matches', content: `No matches for "${input.query}".`, metadata: { count: 0 } };
    }
    const limited = matches.slice(0, input.maxResults);
    const output = limited.map((match) => `${match.file}:${match.line}:${match.column}: ${match.text}`).join('\n');
    return {
      ok: true,
      summary: `Found ${matches.length}${matches.length > limited.length ? '+' : ''} match(es)`,
      content: `${output}${matches.length > limited.length ? `\n… truncated at ${input.maxResults} results` : ''}`,
      metadata: { count: matches.length, truncated: matches.length > limited.length },
    };
  },
});

async function ripgrepSearch(
  input: z.output<typeof searchTextSchema>,
  start: string,
  root: string,
  signal?: AbortSignal,
): Promise<SearchMatch[]> {
  const args = ['--json', '--no-config', '--max-columns', '500', '--max-count', '40'];
  if (!input.caseSensitive) args.push('-i');
  if (!input.regex) args.push('-F');
  if (input.contextLines > 0) args.push('-C', String(input.contextLines));
  for (const dir of ['.git', 'node_modules', 'dist', 'build', 'target']) args.push('--glob', `!${dir}/**`);
  args.push('-e', input.query, '--', start);

  return new Promise<SearchMatch[]>((resolve, reject) => {
    const child = spawn('rg', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    const results: SearchMatch[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ripgrep timed out'));
    }, 25_000);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const match = parseRgLine(line, root);
        if (match) results.push(match);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code === 0 || code === 1) resolve(results);
      else reject(new Error(stderr.trim() || `ripgrep exited with ${code}`));
    });
  });
}

function parseRgLine(line: string, root: string): SearchMatch | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
      };
    };
    if (event.type !== 'match' || !event.data) return null;
    const file = event.data.path?.text;
    if (!file) return null;
    return {
      file: path.relative(root, file).split(path.sep).join('/'),
      line: event.data.line_number ?? 0,
      column: (event.data.submatches?.[0]?.start ?? 0) + 1,
      text: (event.data.lines?.text ?? '')
        .replace(/\r?\n$/, '')
        .trim()
        .slice(0, 500),
    };
  } catch {
    return null;
  }
}

async function fallbackSearch(
  input: z.output<typeof searchTextSchema>,
  start: string,
  root: string,
  ignoreDirectories: string[],
  signal?: AbortSignal,
): Promise<SearchMatch[]> {
  const matcher = input.regex ? new RegExp(input.query, input.caseSensitive ? 'g' : 'gi') : null;
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  const results: SearchMatch[] = [];
  for await (const file of walkFiles({ root, start, maxEntries: 5000, ignoreDirectories, signal })) {
    if (file.size > 1_500_000) continue;
    let content: string;
    try {
      const read = await readTextFileLimited(file.absolute, 1_500_000);
      if (read.binary) continue;
      content = read.content;
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      let column = 0;
      if (matcher) {
        matcher.lastIndex = 0;
        const match = matcher.exec(line);
        if (match) column = match.index + 1;
        else continue;
      } else {
        const haystack = input.caseSensitive ? line : line.toLowerCase();
        const found = haystack.indexOf(needle);
        if (found === -1) continue;
        column = found + 1;
      }
      results.push({ file: file.path, line: index + 1, column, text: line.trim().slice(0, 500) });
      if (results.length >= input.maxResults * 3) return results;
    }
  }
  return results;
}
