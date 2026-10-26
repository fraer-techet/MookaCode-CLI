import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { MookaCore, WorkspaceGuard } from '@mookacode/core';
import { compactContext } from '../src/context/manager';
import { walkFiles } from '../src/workspace/walker';
import { estimateMessagesTokens } from '../src/util/tokens';
import type { AgentMessage } from '@mookacode/protocol';
import { cleanupDir, tempDir } from './helpers/fake-openai';

const execFileAsync = promisify(execFile);
let home = '';
let project = '';
let core: MookaCore | null = null;

beforeEach(async () => {
  home = await tempDir('home');
  project = await tempDir('project');
  process.env.MOOKACODE_HOME = home;
});

afterEach(async () => {
  await core?.close().catch(() => undefined);
  core = null;
  await cleanupDir(home);
  await cleanupDir(project);
  delete process.env.MOOKACODE_HOME;
});

describe('workspace safety', () => {
  it('rejects traversal and absolute paths outside the workspace', async () => {
    const guard = new WorkspaceGuard(project);
    await expect(guard.resolve('../outside.txt')).rejects.toThrow(/outside the workspace/i);
    await expect(guard.resolve(path.join(project, '..', 'outside.txt'))).rejects.toThrow(/outside the workspace/i);
    if (process.platform === 'win32') {
      await expect(guard.resolve('C:\\Windows\\win.ini')).rejects.toThrow(/outside the workspace/i);
    } else {
      await expect(guard.resolve('/etc/passwd')).rejects.toThrow(/outside the workspace/i);
    }
    await expect(guard.resolve('inside.txt', { forWrite: true })).resolves.toContain('inside.txt');
  });

  it('rejects a symlink that escapes the workspace when the OS permits creating one', async () => {
    const outside = await tempDir('outside');
    try {
      const linkPath = path.join(project, 'escape');
      try {
        await symlink(outside, linkPath, 'junction');
      } catch {
        return;
      }
      const guard = new WorkspaceGuard(project);
      await expect(guard.resolve('escape/secret.txt')).rejects.toThrow(/outside the workspace|symlink/i);
    } finally {
      await cleanupDir(outside);
    }
  });
});

describe('nested gitignore', () => {
  it('honors a nested .gitignore relative to its directory', async () => {
    await mkdir(path.join(project, 'src', 'generated'), { recursive: true });
    await writeFile(path.join(project, 'src', '.gitignore'), 'generated/\n*.log\n', 'utf8');
    await writeFile(path.join(project, 'src', 'keep.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(project, 'src', 'debug.log'), 'ignored\n', 'utf8');
    await writeFile(path.join(project, 'src', 'generated', 'file.ts'), 'ignored\n', 'utf8');
    const paths: string[] = [];
    for await (const file of walkFiles({ root: project })) paths.push(file.path);
    expect(paths).toContain('src/keep.ts');
    expect(paths).not.toContain('src/debug.log');
    expect(paths).not.toContain('src/generated/file.ts');
  });
});

describe('context compaction', () => {
  it('preserves the current task and compresses old tool output', () => {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 8; index++) {
      messages.push({
        id: `u${index}`,
        role: 'user',
        content: `Task ${index}: investigate a very specific problem number ${index}`,
        createdAt: Date.now(),
      });
      messages.push({
        id: `a${index}`,
        role: 'assistant',
        content: `Working on task ${index}`,
        toolCalls: [{ id: `call${index}`, name: 'search_text', arguments: { query: `needle-${index}` } }],
        createdAt: Date.now(),
      });
      messages.push({
        id: `t${index}`,
        role: 'tool',
        content: `search result ${index}\n${'x'.repeat(8000)}`,
        toolCallId: `call${index}`,
        toolName: 'search_text',
        createdAt: Date.now(),
      });
      messages.push({
        id: `a2${index}`,
        role: 'assistant',
        content: `Finished task ${index}`,
        createdAt: Date.now(),
      });
    }
    const before = estimateMessagesTokens(messages);
    const compacted = compactContext(messages, { targetTokens: 2200, maxToolResultChars: 1200 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.afterTokens).toBeLessThan(before);
    expect(compacted.messages.some((message) => message.content.includes('Task 7'))).toBe(true);
    expect(compacted.summary).toContain('Task 0');
  });
});

describe('sessions', () => {
  it('persists sessions, resumes pending work and redacts secrets', async () => {
    core = await MookaCore.create({ cwd: project });
    const secret = 'sk-testabcdefghijklmnopqrstuvwxyz012345';
    const record = await core.sessionStore.create({
      cwd: project,
      projectRoot: project,
      mode: 'build',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      title: 'Persistence test',
    });
    record.pendingTask = 'Finish the work';
    record.messages.push({
      id: 'm1',
      role: 'user',
      content: `use ${secret} but do not store it`,
      createdAt: Date.now(),
    });
    await core.sessionStore.save(record);
    const stored = await readFile(path.join(home, 'sessions', `${record.id}.json`), 'utf8');
    expect(stored).not.toContain(secret);
    expect(stored).toContain('sk-***');
    const sessions = await core.listSessions();
    expect(sessions[0]?.id).toBe(record.id);
    const loaded = await core.getSession(record.id);
    expect(loaded?.pendingTask).toBe('Finish the work');
    expect(loaded?.messages[0]?.content).not.toContain(secret);
    await core.close();
    core = await MookaCore.create({ cwd: project });
    const afterRestart = await core.getSession(record.id);
    expect(afterRestart?.title).toBe('Persistence test');
  });
});

describe('trust', () => {
  it('ignores project config until explicitly trusted', async () => {
    await mkdir(path.join(project, '.mookacode'), { recursive: true });
    await writeFile(
      path.join(project, '.mookacode', 'config.json'),
      JSON.stringify({
        permissions: { edit: 'deny' },
        mcpServers: [{ id: 'project-mcp', transport: 'stdio', command: 'node' }],
      }),
      'utf8',
    );
    core = await MookaCore.create({ cwd: project });
    expect(core.snapshot.hasProjectConfig).toBe(true);
    expect(core.snapshot.projectTrusted).toBe(false);
    expect(core.config.permissions.edit).toBe('ask');
    expect(core.config.mcpServers.some((server) => server.id === 'project-mcp')).toBe(false);
    await core.trustCurrentProject();
    expect(core.snapshot.projectTrusted).toBe(true);
    expect(core.config.permissions.edit).toBe('deny');
    expect(core.config.mcpServers.some((server) => server.id === 'project-mcp')).toBe(true);
  });
});

describe('git', () => {
  it('reports status and diff and creates a non-destructive checkpoint', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd: project });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: project });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: project });
    await writeFile(path.join(project, 'file.txt'), 'one\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: project });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: project });
    core = await MookaCore.create({ cwd: project });
    expect((await core.gitStatus()).clean).toBe(true);
    await writeFile(path.join(project, 'file.txt'), 'one\ntwo\n', 'utf8');
    const status = await core.gitStatus();
    expect(status.clean).toBe(false);
    expect(status.files[0]?.path).toBe('file.txt');
    const diff = await core.gitDiff();
    expect(diff).toContain('+two');
    const checkpoint = await core.git.createCheckpoint('test checkpoint');
    expect(checkpoint).not.toBeNull();
    const refs = await execFileAsync('git', ['show-ref'], { cwd: project });
    expect(refs.stdout).toContain('refs/mookacode/checkpoints/');
    expect(await readFile(path.join(project, 'file.txt'), 'utf8')).toBe('one\ntwo\n');
  });
});
