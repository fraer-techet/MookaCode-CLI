import { z } from 'zod';
import type { ToolResult } from '@mookacode/protocol';
import { defineTool, moderateRisk, safeRisk } from './types';

const statusSchema = z.object({});

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show the current Git branch, upstream and changed files. Read-only.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: statusSchema,
  risk: () => safeRisk('Read-only Git status.'),
  title: () => 'Git status',
  detail: () => 'Read branch and working tree status.',
  async execute(_input, ctx): Promise<ToolResult> {
    if (!(await ctx.git.isAvailable())) throw new Error('Git is not installed or not available in PATH.');
    if (!(await ctx.git.isRepository()))
      return { ok: true, summary: 'Not a Git repository', content: `Not a Git repository: ${ctx.root}` };
    const status = await ctx.git.status();
    const lines = [
      `Branch: ${status.branch}${status.upstream ? ` -> ${status.upstream}` : ''}`,
      status.clean ? 'Working tree clean.' : `${status.files.length} changed file(s):`,
      ...status.files.map((file) => `${file.kind.padEnd(9)} ${file.path}`),
    ];
    return {
      ok: true,
      summary: status.clean ? 'Git working tree clean' : `${status.files.length} changed file(s)`,
      content: lines.join('\n'),
      metadata: { branch: status.branch, clean: status.clean, files: status.files },
    };
  },
});

const diffSchema = z.object({
  paths: z.array(z.string()).optional().describe('Optional paths to limit the diff'),
  staged: z.boolean().optional().default(false).describe('Show staged changes instead of unstaged'),
});

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description: 'Show unified Git diff for the working tree or index, optionally limited to paths. Read-only.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: diffSchema,
  risk: () => safeRisk('Read-only Git diff.'),
  title: (input) => `Git diff${input.paths?.length ? `: ${input.paths.join(', ')}` : ''}`,
  detail: (input) => `Unified diff${input.staged ? ' (staged)' : ''}.`,
  paths: (input) => input.paths ?? [],
  async execute(input, ctx): Promise<ToolResult> {
    if (!(await ctx.git.isRepository())) throw new Error('Not a Git repository.');
    const resolvedPaths: string[] = [];
    for (const item of input.paths ?? []) {
      const target = await ctx.guard.resolve(item, { mustExist: false });
      resolvedPaths.push(ctx.guard.relative(target));
    }
    const [diff, status] = await Promise.all([
      ctx.git.diff(resolvedPaths.length ? resolvedPaths : undefined, { staged: input.staged }),
      ctx.git.status(),
    ]);
    const untracked = status.files.filter((file) => file.kind === 'created').map((file) => file.path);
    const note = untracked.length ? `\n\nUntracked files (not included in git diff):\n${untracked.join('\n')}` : '';
    return {
      ok: true,
      summary: diff.trim() ? 'Git diff generated' : 'No tracked changes in diff',
      content: `${diff.trim() || '(no diff)'}${note}`,
      metadata: { files: resolvedPaths, staged: input.staged, untracked },
    };
  },
});

const logSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(15),
});

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show recent Git commits. Read-only.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: logSchema,
  risk: () => safeRisk('Read-only Git history.'),
  title: () => 'Git log',
  detail: (input) => `Show ${input.limit} recent commits.`,
  async execute(input, ctx): Promise<ToolResult> {
    if (!(await ctx.git.isRepository())) throw new Error('Not a Git repository.');
    const commits = await ctx.git.log(input.limit);
    const content = commits
      .map((commit) => `${commit.hash.slice(0, 10)}  ${commit.date}  ${commit.author}  ${commit.subject}`)
      .join('\n');
    return {
      ok: true,
      summary: `${commits.length} commit(s)`,
      content: content || 'No commits.',
      metadata: { commits },
    };
  },
});

const showSchema = z.object({
  ref: z.string().min(1).describe('Git revision, for example HEAD or a commit hash'),
  path: z.string().optional().describe('Optional file path at that revision'),
});

export const gitShowTool = defineTool({
  name: 'git_show',
  description: 'Show a commit, tag or revision with patch, optionally restricted to a file. Read-only.',
  category: 'read',
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: showSchema,
  risk: () => safeRisk('Read-only Git object inspection.'),
  title: (input) => `Git show ${input.ref}`,
  detail: (input) => `Show ${input.ref}${input.path ? ` path ${input.path}` : ''}.`,
  async execute(input, ctx): Promise<ToolResult> {
    if (!(await ctx.git.isRepository())) throw new Error('Not a Git repository.');
    const output = await ctx.git.show(input.ref, input.path);
    return { ok: true, summary: `Git show ${input.ref}`, content: output || '(empty output)' };
  },
});

const branchSchema = z.object({
  action: z.enum(['list', 'create', 'switch']).default('list'),
  name: z.string().optional().describe('Branch name for create or switch'),
});

export const gitBranchTool = defineTool({
  name: 'git_branch',
  description: 'List branches, or create/switch a branch. Creating and switching branches require permission.',
  category: (input) => (input.action === 'list' ? 'read' : 'gitWrite'),
  modes: ['plan', 'build', 'debug', 'ask', 'review'],
  schema: branchSchema,
  risk: (input) =>
    input.action === 'list' ? safeRisk('Read-only branch listing.') : moderateRisk('Changes the Git working branch.'),
  title: (input) =>
    input.action === 'list' ? 'List Git branches' : `${input.action} branch ${input.name ?? ''}`.trim(),
  detail: (input) =>
    input.action === 'list' ? 'List local branches.' : `${input.action} branch "${input.name ?? ''}".`,
  async execute(input, ctx): Promise<ToolResult> {
    if (!(await ctx.git.isRepository())) throw new Error('Not a Git repository.');
    if (input.action === 'list') {
      const branches = await ctx.git.branches();
      return {
        ok: true,
        summary: `${branches.branches.length} branch(es)`,
        content: branches.branches.map((branch) => `${branch === branches.current ? '*' : ' '} ${branch}`).join('\n'),
        metadata: branches,
      };
    }
    if (!input.name) throw new Error('Branch name is required for create or switch.');
    if (input.action === 'create') await ctx.git.createBranch(input.name);
    else await ctx.git.switchBranch(input.name);
    return {
      ok: true,
      summary: `Branch ${input.action === 'create' ? 'created' : 'switched'}: ${input.name}`,
      content: `Current branch is now ${input.name}.`,
    };
  },
});
