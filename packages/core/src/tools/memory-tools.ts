import { z } from 'zod';
import type { ToolResult } from '@mookacode/protocol';
import { MemoryStore } from '../context/memory';
import { defineTool, moderateRisk, safeRisk } from './types';

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).optional().default(10),
});

export const memorySearchTool = defineTool({
  name: 'memory_search',
  description:
    'Search MookaCode persistent project memory for earlier decisions, known issues and unfinished work. Memory may be stale; verify against the code.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: searchSchema,
  risk: () => safeRisk('Reads local project memory.'),
  title: (input) => `Memory search: ${input.query}`,
  detail: (input) => `Search project memory for "${input.query}".`,
  async execute(input, ctx): Promise<ToolResult> {
    const store = new MemoryStore(ctx.root, ctx.config.context.memoryMaxEntries);
    const entries = await store.relevant(input.query, input.limit);
    return {
      ok: true,
      summary: `${entries.length} memory entr${entries.length === 1 ? 'y' : 'ies'}`,
      content: entries.length
        ? entries
            .map((entry) => `[${entry.kind}] ${entry.text}${entry.files?.length ? ` (${entry.files.join(', ')})` : ''}`)
            .join('\n\n')
        : 'No relevant memory entries.',
      metadata: { count: entries.length },
    };
  },
});

const writeSchema = z.object({
  kind: z.enum(['decision', 'unfinished', 'known-issue', 'fact']),
  text: z.string().min(5).max(2000),
  files: z.array(z.string()).optional(),
});

export const memoryWriteTool = defineTool({
  name: 'memory_write',
  description:
    'Save a durable, non-secret project fact, technical decision, known issue or unfinished task to .mookacode/memory.json. Use sparingly, not as a log.',
  category: 'edit',
  modes: ['build', 'debug'],
  schema: writeSchema,
  risk: (input) => moderateRisk(`Adds a ${input.kind} entry to project memory.`),
  title: (input) => `Remember ${input.kind}`,
  detail: (input) => input.text.slice(0, 300),
  async execute(input, ctx): Promise<ToolResult> {
    for (const file of input.files ?? []) await ctx.guard.resolve(file, { forWrite: true });
    const store = new MemoryStore(ctx.root, ctx.config.context.memoryMaxEntries);
    const entry = await store.add({
      kind: input.kind,
      text: input.text,
      files: input.files,
    });
    return {
      ok: true,
      summary: `Saved ${entry.kind} to project memory`,
      content: `Saved to project memory (${entry.id}).`,
      metadata: { id: entry.id },
    };
  },
});
