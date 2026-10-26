import { spawn } from 'node:child_process';
import type { ChangedFile, Checkpoint } from '@mookacode/protocol';
import { MookaError } from '../util/errors';
import { shortId } from '../util/ids';

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runGit(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; maxOutput?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const max = options.maxOutput ?? 500_000;
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer) =>
      current.length > max ? current : current + chunk.toString('utf8');
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new MookaError('GIT_TIMEOUT', `Git command timed out: git ${args.join(' ')}`));
    }, options.timeoutMs ?? 60_000);
    timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new MookaError('GIT_UNAVAILABLE', `Git is not available: ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function cleanPath(value: string): string {
  let result = value.trim();
  if (result.startsWith('"') && result.endsWith('"')) {
    try {
      result = JSON.parse(result) as string;
    } catch {
      result = result.slice(1, -1);
    }
  }
  return result;
}

export class GitService {
  readonly cwd: string;
  private available?: boolean;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) return this.available;
    try {
      const result = await runGit(['--version'], this.cwd);
      this.available = result.code === 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async isRepository(): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], this.cwd);
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  private async requireRepo(): Promise<void> {
    if (!(await this.isRepository())) {
      throw new MookaError('GIT_NOT_REPOSITORY', `Not a Git repository: ${this.cwd}`);
    }
  }

  async status(): Promise<{ branch: string; upstream?: string; clean: boolean; files: ChangedFile[] }> {
    await this.requireRepo();
    const [branch, status] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd),
      runGit(['status', '--porcelain=v1'], this.cwd),
    ]);
    const upstreamResult = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], this.cwd);
    const files: ChangedFile[] = [];
    for (const line of status.stdout.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let filePath = cleanPath(line.slice(3));
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop() ?? filePath;
      if (code === '??') files.push({ path: filePath, kind: 'created' });
      else if (code.includes('D')) files.push({ path: filePath, kind: 'deleted' });
      else if (code.includes('R')) files.push({ path: filePath, kind: 'renamed' });
      else files.push({ path: filePath, kind: 'modified' });
    }
    return {
      branch: branch.code === 0 ? branch.stdout.trim() : 'HEAD',
      upstream: upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined,
      clean: files.length === 0,
      files,
    };
  }

  async diff(paths?: string[], options: { staged?: boolean; context?: number } = {}): Promise<string> {
    await this.requireRepo();
    const context = Math.max(0, Math.min(100_000, options.context ?? 3));
    const args = ['diff', '--no-ext-diff', '--no-color', `--unified=${context}`];
    if (options.staged) args.push('--cached');
    if (paths?.length) args.push('--', ...paths);
    const result = await runGit(args, this.cwd);
    if (result.code !== 0) throw new MookaError('GIT_DIFF_FAILED', result.stderr.trim() || 'git diff failed');
    return result.stdout;
  }

  async diffStat(paths?: string[]): Promise<string> {
    await this.requireRepo();
    const args = ['diff', '--stat', '--no-color'];
    if (paths?.length) args.push('--', ...paths);
    const result = await runGit(args, this.cwd);
    return result.stdout;
  }

  async log(limit = 20): Promise<Array<{ hash: string; author: string; date: string; subject: string }>> {
    await this.requireRepo();
    const result = await runGit(
      ['log', `-n${Math.max(1, Math.min(200, limit))}`, '--pretty=format:%H%x1f%an%x1f%ar%x1f%s'],
      this.cwd,
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash = '', author = '', date = '', subject = ''] = line.split('\x1f');
        return { hash, author, date, subject };
      });
  }

  async show(ref: string, file?: string): Promise<string> {
    await this.requireRepo();
    if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(ref)) throw new MookaError('GIT_INVALID_REF', 'Invalid Git revision');
    const args = ['show', '--no-color', '--stat', '--patch', ref];
    if (file) args.push('--', file);
    const result = await runGit(args, this.cwd);
    if (result.code !== 0) throw new MookaError('GIT_SHOW_FAILED', result.stderr.trim() || 'git show failed');
    return result.stdout;
  }

  async branches(): Promise<{ current: string; branches: string[] }> {
    await this.requireRepo();
    const [current, list] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd),
      runGit(['branch', '--list', '--format=%(refname:short)'], this.cwd),
    ]);
    return {
      current: current.stdout.trim(),
      branches: list.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
  }

  async createBranch(name: string, checkout = true): Promise<void> {
    await this.requireRepo();
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-')) {
      throw new MookaError('GIT_INVALID_BRANCH', 'Invalid branch name');
    }
    const result = checkout
      ? await runGit(['checkout', '-b', name], this.cwd)
      : await runGit(['branch', name], this.cwd);
    if (result.code !== 0) throw new MookaError('GIT_BRANCH_FAILED', result.stderr.trim() || 'Could not create branch');
  }

  async switchBranch(name: string): Promise<void> {
    await this.requireRepo();
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('-')) {
      throw new MookaError('GIT_INVALID_BRANCH', 'Invalid branch name');
    }
    const result = await runGit(['checkout', name], this.cwd);
    if (result.code !== 0) throw new MookaError('GIT_SWITCH_FAILED', result.stderr.trim() || 'Could not switch branch');
  }

  async currentHead(): Promise<string | null> {
    if (!(await this.isRepository())) return null;
    const result = await runGit(['rev-parse', 'HEAD'], this.cwd);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async createCheckpoint(label: string): Promise<Checkpoint | null> {
    await this.requireRepo();
    const stash = await runGit(['stash', 'create', `mooka checkpoint: ${label}`], this.cwd);
    let sha = stash.stdout.trim();
    if (!sha) {
      const head = await this.currentHead();
      if (!head) return null;
      sha = head;
    }
    const id = shortId('cp');
    const ref = `refs/mookacode/checkpoints/${id}`;
    const update = await runGit(['update-ref', ref, sha], this.cwd);
    if (update.code !== 0) {
      throw new MookaError('GIT_CHECKPOINT_FAILED', update.stderr.trim() || 'Could not create checkpoint ref');
    }
    return {
      id,
      label,
      ref,
      createdAt: Date.now(),
      head: (await this.currentHead()) ?? sha,
    };
  }

  async applyCheckpoint(ref: string): Promise<void> {
    await this.requireRepo();
    if (!ref.startsWith('refs/mookacode/checkpoints/')) {
      throw new MookaError('GIT_INVALID_REF', 'Only MookaCode checkpoint refs can be applied');
    }
    const result = await runGit(['stash', 'apply', ref], this.cwd);
    if (result.code !== 0) {
      throw new MookaError('GIT_CHECKPOINT_APPLY_FAILED', `Could not apply checkpoint: ${result.stderr.trim()}`);
    }
  }

  async fileAtHead(file: string): Promise<string | null> {
    if (!(await this.isRepository())) return null;
    const result = await runGit(['show', `HEAD:${file}`], this.cwd);
    return result.code === 0 ? result.stdout : null;
  }
}
