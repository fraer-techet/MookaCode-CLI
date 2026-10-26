import { z } from 'zod';
import type { ToolResult } from '@mookacode/protocol';
import { runShellCommand } from '../util/shell';
import { defineTool, highRisk, moderateRisk, safeRisk } from './types';

const UNSAFE_PATTERNS: Array<[RegExp, string]> = [
  [
    /\brm\s+(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\s+(\/|~|\$HOME|[A-Za-z]:[\\/])/i,
    'recursive deletion of an absolute or home path',
  ],
  [/\bRemove-Item\b.*\s-(Recurse|Force)/i, 'recursive PowerShell deletion'],
  [/\b(del|rd|rmdir)\s+\/[sq]/i, 'recursive Windows deletion'],
  [/\b(format|mkfs(\.\w+)?|diskpart)\b/i, 'disk formatting'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force|branch\s+-D)/i, 'destructive Git operation'],
  [/\b(shutdown|reboot|halt)\b/i, 'system shutdown'],
  [/\b(sudo|runas)\b/i, 'privilege escalation'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|powershell|pwsh)/i, 'piping remote content into a shell'],
  [/\bDROP\s+(TABLE|DATABASE)\b/i, 'destructive database operation'],
  [/\bnpm\s+(publish|unpublish)\b/i, 'package publication'],
  [/\bgit\s+push\b/i, 'publishing commits to a remote'],
];

const SAFE_PREFIXES = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch --list',
  'git rev-parse',
  'pwd',
  'ls',
  'dir',
  'Get-ChildItem',
  'Get-Content',
  'cat ',
  'head ',
  'tail ',
  'node --version',
  'npm --version',
  'pnpm --version',
  'cargo --version',
  'python --version',
  'rg ',
];

export function commandRisk(command: string) {
  const trimmed = command.trim();
  for (const [pattern, reason] of UNSAFE_PATTERNS) {
    if (pattern.test(trimmed)) return highRisk(`Potentially destructive command: ${reason}.`);
  }
  if (/[;&|`]|\$\(|\n/.test(trimmed)) {
    return moderateRisk('Compound shell command. Permissions apply to the whole command.');
  }
  if (SAFE_PREFIXES.some((prefix) => trimmed === prefix.trim() || trimmed.startsWith(prefix))) {
    return safeRisk('Read-only or informational command.');
  }
  if (/\b(install|add|update|upgrade|remove|uninstall|publish)\b/i.test(trimmed)) {
    return moderateRisk('May install packages or modify dependencies.');
  }
  if (/\b(build|test|lint|typecheck|check|run|exec)\b/i.test(trimmed)) {
    return moderateRisk('Executes project code or build tooling.');
  }
  return moderateRisk('Runs a shell command with project permissions.');
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const blocked =
    /(?:^|_)(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY)(?:_|$)/i;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (blocked.test(key)) continue;
    if (/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|GITHUB)_/i.test(key) && /KEY|TOKEN|SECRET|PASSWORD/i.test(key))
      continue;
    result[key] = value;
  }
  return result;
}

const commandSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  cwd: z.string().optional().describe('Working directory relative to workspace root'),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 60_000)
    .optional()
    .describe('Timeout in milliseconds'),
});

export const runCommandTool = defineTool({
  name: 'run_command',
  description:
    'Run a shell command in the workspace with a timeout. Returns exit code, stdout and stderr. Use for builds, tests, linters and inspection. Destructive commands are classified as high risk and require permission.',
  category: 'command',
  modes: ['build', 'debug'],
  schema: commandSchema,
  risk: (input) => commandRisk(input.command),
  title: (input) => `Run: ${input.command.slice(0, 100)}`,
  detail: (input) => `Execute in ${input.cwd || '.'} with a timeout of ${input.timeoutMs ?? 120000}ms.`,
  paths: (input) => (input.cwd ? [input.cwd] : []),
  command: (input) => input.command,
  async execute(input, ctx): Promise<ToolResult> {
    const cwd = input.cwd ? await ctx.guard.resolve(input.cwd, { mustExist: true }) : ctx.root;
    const result = await runShellCommand({
      command: input.command,
      cwd,
      shell: ctx.config.shell,
      timeoutMs: input.timeoutMs ?? 120_000,
      signal: ctx.signal,
      env: safeEnvironment(),
      maxOutputChars: 80_000,
    });
    const parts = [`Exit code: ${result.exitCode ?? 'none'}${result.timedOut ? ' (timed out)' : ''}`];
    if (result.stdout.trim()) parts.push(`\n--- stdout ---\n${result.stdout.trimEnd()}`);
    if (result.stderr.trim()) parts.push(`\n--- stderr ---\n${result.stderr.trimEnd()}`);
    if (!result.stdout.trim() && !result.stderr.trim()) parts.push('\n(no output)');
    return {
      ok: !result.timedOut,
      summary: result.timedOut
        ? `Command timed out after ${input.timeoutMs ?? 120000}ms: ${input.command}`
        : `Command exited with ${result.exitCode}${result.truncated ? ' (output truncated)' : ''}`,
      content: parts.join('\n'),
      metadata: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        durationMs: result.durationMs,
        cwd: ctx.guard.relative(cwd),
        command: input.command,
      },
    };
  },
});

const testSchema = z.object({
  command: z.string().optional().describe('Explicit test command. If omitted, a command is detected from the project.'),
  cwd: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 60_000)
    .optional(),
});

export const testRunnerTool = defineTool({
  name: 'test_runner',
  description:
    'Run the project test suite. Detects npm/pnpm/yarn, Cargo, pytest, Go and .NET projects, or accepts an explicit command. Returns the failing output and exit code.',
  category: 'command',
  modes: ['build', 'debug'],
  schema: testSchema,
  risk: (input) => commandRisk(input.command || 'test suite'),
  title: () => 'Run tests',
  detail: (input) => (input.command ? `Run "${input.command}".` : 'Detect and run the project test suite.'),
  command: (input) => input.command,
  async execute(input, ctx): Promise<ToolResult> {
    const detection = await detectTestCommand(ctx.root, ctx.project);
    const command = input.command || detection?.command;
    if (!command) {
      throw new Error(
        'Could not detect a test command. Pass an explicit command, for example { "command": "npm test" }.',
      );
    }
    const cwd = input.cwd ? await ctx.guard.resolve(input.cwd, { mustExist: true }) : ctx.root;
    const started = Date.now();
    const result = await runShellCommand({
      command,
      cwd,
      shell: ctx.config.shell,
      timeoutMs: input.timeoutMs ?? 10 * 60_000,
      signal: ctx.signal,
      env: safeEnvironment(),
      maxOutputChars: 100_000,
    });
    const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
    return {
      ok: !result.timedOut,
      summary:
        result.exitCode === 0
          ? `Tests passed (${command})`
          : result.timedOut
            ? `Tests timed out (${command})`
            : `Tests failed with exit code ${result.exitCode} (${command})`,
      content: `Command: ${command}\nExit code: ${result.exitCode ?? 'none'}${result.timedOut ? ' (timed out)' : ''}\n\n${output || '(no output)'}`,
      metadata: { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: Date.now() - started, command },
    };
  },
});

async function detectTestCommand(
  root: string,
  project: { scripts: Record<string, string>; info: { packageManager?: string; projectTypes: string[] } },
): Promise<{ command: string } | null> {
  if (project.scripts.test) {
    const manager = project.info.packageManager ?? 'npm';
    if (manager === 'pnpm') return { command: 'pnpm test' };
    if (manager === 'yarn') return { command: 'yarn test' };
    if (manager === 'bun') return { command: 'bun test' };
    return { command: 'npm test' };
  }
  const fs = await import('node:fs/promises');
  const exists = async (name: string) =>
    fs
      .stat(`${root}/${name}`)
      .then(() => true)
      .catch(() => false);
  if (await exists('Cargo.toml')) return { command: 'cargo test' };
  if ((await exists('pyproject.toml')) || (await exists('pytest.ini')) || (await exists('tests')))
    return { command: 'python -m pytest' };
  if (await exists('go.mod')) return { command: 'go test ./...' };
  if ((await exists('*.sln')) || (await exists('*.csproj'))) return { command: 'dotnet test' };
  return null;
}
