import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolResult } from '@mookacode/protocol';
import { readTextFileLimited } from '../workspace/walker';
import { createUnifiedDiff } from '../workspace/diff';
import { atomicWrite, fileSha256 } from '../util/fs';
import { formatNumber } from '../util/format';
import { defineTool, moderateRisk, safeRisk } from './types';
import { previewText } from './registry';

const sensitivePattern =
  /(^|[\\/])(\.env(\..*)?|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx)|credentials|secrets?)([\\/]|$)/i;

function sensitiveRisk(filePath: string, fallback: 'safe' | 'moderate') {
  if (sensitivePattern.test(filePath))
    return { level: 'high' as const, reason: 'The path looks like it may contain credentials or private keys.' };
  return fallback === 'safe' ? safeRisk('Reads project files only.') : moderateRisk('Modifies a project file.');
}

const readFileSchema = z.object({
  path: z.string().min(1).describe('File path relative to the workspace root'),
  startLine: z.number().int().min(1).optional().describe('First line to return (1-based)'),
  endLine: z.number().int().min(1).optional().describe('Last line to return (inclusive)'),
  maxChars: z.number().int().min(200).max(200_000).optional().describe('Maximum characters to return'),
});

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the workspace. Returns line numbers and a SHA-256 hash for conflict-safe edits. Use ranges for large files.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: readFileSchema,
  risk: (input) => sensitiveRisk(input.path, 'safe'),
  title: (input) => `Read ${input.path}`,
  detail: (input) => `Read ${input.path}${input.startLine ? ` from line ${input.startLine}` : ''}.`,
  paths: (input) => [input.path],
  async execute(input, ctx): Promise<ToolResult> {
    const target = await ctx.guard.resolve(input.path, { mustExist: true });
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Not a regular file: ${input.path}`);
    const limited = await readTextFileLimited(target, 4_000_000);
    if (limited.binary) throw new Error(`Binary files are not supported by read_file: ${input.path}`);
    const allLines = limited.content.split(/\r?\n/);
    const start = Math.max(1, input.startLine ?? 1);
    const end = Math.min(allLines.length, input.endLine ?? Math.min(allLines.length, start + 499));
    if (start > allLines.length)
      throw new Error(`startLine ${start} is beyond the end of ${input.path} (${allLines.length} lines)`);
    if (end < start) throw new Error('endLine must be greater than or equal to startLine');
    const maxChars = input.maxChars ?? 40_000;
    const selected = allLines.slice(start - 1, end);
    let output = selected.map((line, index) => `${String(start + index).padStart(6, ' ')} | ${line}`).join('\n');
    let truncated = false;
    if (output.length > maxChars) {
      output = `${output.slice(0, maxChars)}\n… [line range truncated at ${maxChars} chars; request a smaller range]`;
      truncated = true;
    }
    const hash = await fileSha256(target);
    return {
      ok: true,
      summary: `Read ${input.path} (lines ${start}-${end} of ${allLines.length})`,
      content: `File: ${ctx.guard.relative(target)}\nLines ${start}-${end} of ${allLines.length}${truncated ? ' (output truncated)' : ''}\nSHA-256: ${hash}\n\n${output}`,
      metadata: {
        path: ctx.guard.relative(target),
        sha256: hash,
        size: info.size,
        lines: allLines.length,
        startLine: start,
        endLine: end,
        truncated,
      },
    };
  },
});

const writeFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().optional().default(false).describe('Must be true to replace an existing file'),
  expected_sha256: z
    .string()
    .optional()
    .describe('Current file hash from read_file. Required when overwriting an existing file'),
});

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create a new text file or replace an existing file. Prefer edit_file for existing files. Overwrites require overwrite=true and the expected_sha256 returned by read_file.',
  category: 'edit',
  modes: ['build', 'debug'],
  schema: writeFileSchema,
  risk: (input) => moderateRisk(`Writes ${input.path}`),
  title: (input) => `Write ${input.path}`,
  detail: (input) =>
    `${input.overwrite ? 'Replace' : 'Create'} ${input.path} (${formatNumber(input.content.length)} characters).`,
  paths: (input) => [input.path],
  preview: (input) => previewText(input),
  async execute(input, ctx): Promise<ToolResult> {
    const target = await ctx.guard.resolve(input.path, { forWrite: true });
    const relative = ctx.guard.relative(target);
    const existing = await stat(target).catch(() => null);
    let before = '';
    let additions = 0;
    let deletions = 0;
    if (existing?.isDirectory()) throw new Error(`Cannot write to a directory: ${relative}`);
    if (existing) {
      if (!input.overwrite) {
        throw new Error(
          `File already exists: ${relative}. Use edit_file, or pass overwrite=true with the hash from read_file.`,
        );
      }
      if (!input.expected_sha256) {
        throw new Error(
          `Refusing to overwrite ${relative} without expected_sha256. Read the file first and pass its SHA-256 to detect concurrent edits.`,
        );
      }
      before = await readFile(target, 'utf8');
      if ((await fileSha256(target)) !== input.expected_sha256) {
        throw new Error(`Concurrent modification detected for ${relative}. Read the file again before overwriting.`);
      }
      const diff = createUnifiedDiff(relative, before, input.content);
      additions = diff.additions;
      deletions = diff.deletions;
      await atomicWrite(target, input.content, (await stat(target)).mode);
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content, 'utf8');
      additions = input.content.split('\n').length;
    }
    return {
      ok: true,
      summary: `${existing ? 'Updated' : 'Created'} ${relative}`,
      content: `${existing ? 'Updated' : 'Created'} ${relative}\n${existing ? `+${additions} -${deletions} lines` : `${additions} line(s)`}`,
      changedFiles: [{ path: relative, kind: existing ? 'modified' : 'created', additions, deletions }],
      metadata: { path: relative, additions, deletions },
    };
  },
});

const editFileSchema = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1).describe('Exact text to replace; must occur exactly once unless replaceAll is true'),
  newString: z.string(),
  replaceAll: z.boolean().optional().default(false),
  expected_sha256: z.string().optional().describe('Hash from read_file; detects concurrent edits'),
});

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Apply a precise text edit to an existing file. oldString must match exactly. The tool rejects ambiguous matches, detects concurrent modifications, and returns a unified diff.',
  category: 'edit',
  modes: ['build', 'debug'],
  schema: editFileSchema,
  risk: (input) => moderateRisk(`Edits ${input.path}`),
  title: (input) => `Edit ${input.path}`,
  detail: (input) => `Replace a snippet in ${input.path}${input.replaceAll ? ' (all occurrences)' : ''}.`,
  paths: (input) => [input.path],
  preview: (input) => previewText(input),
  async execute(input, ctx): Promise<ToolResult> {
    const target = await ctx.guard.resolve(input.path, { mustExist: true });
    const relative = ctx.guard.relative(target);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Not a regular file: ${relative}`);
    if (info.size > 8_000_000) throw new Error(`File is too large for edit_file: ${relative}`);
    if (input.expected_sha256 && (await fileSha256(target)) !== input.expected_sha256) {
      throw new Error(`Concurrent modification detected for ${relative}. Read the file again before editing.`);
    }
    const before = await readFile(target, 'utf8');
    const first = before.indexOf(input.oldString);
    if (first === -1)
      throw new Error(`oldString was not found in ${relative}. Read the current file and copy the exact text.`);
    if (!input.replaceAll && before.indexOf(input.oldString, first + input.oldString.length) !== -1) {
      throw new Error(
        `oldString occurs more than once in ${relative}. Add surrounding context or set replaceAll=true.`,
      );
    }
    const count = input.replaceAll ? before.split(input.oldString).length - 1 : 1;
    const after = input.replaceAll
      ? before.split(input.oldString).join(input.newString)
      : before.slice(0, first) + input.newString + before.slice(first + input.oldString.length);
    const diff = createUnifiedDiff(relative, before, after);
    await atomicWrite(target, after, info.mode);
    return {
      ok: true,
      summary: `Edited ${relative} (${count} replacement${count === 1 ? '' : 's'})`,
      content: `Edited ${relative}\n+${diff.additions} -${diff.deletions}\n\n${diff.patch}`,
      changedFiles: [{ path: relative, kind: 'modified', additions: diff.additions, deletions: diff.deletions }],
      metadata: { path: relative, additions: diff.additions, deletions: diff.deletions, replacements: count },
    };
  },
});
