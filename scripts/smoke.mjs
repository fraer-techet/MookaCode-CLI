import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'packages', 'cli', 'dist', 'mookacode.cjs');
const pkg = JSON.parse(await readFile(path.join(root, 'packages', 'cli', 'package.json'), 'utf8'));

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'mookacode-smoke-home-'));
  const project = await mkdtemp(path.join(tmpdir(), 'mookacode-smoke-project-'));
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'src', 'index.ts'), 'export const answer = 42;\n');
  const env = { MOOKACODE_HOME: home, NO_COLOR: '1' };
  try {
    const help = await runNode([cli, '--help'], { env, cwd: project });
    if (help.code !== 0 || !help.stdout.includes('MookaCode')) throw new Error('CLI help smoke test failed');

    const version = await runNode([cli, '--version'], { env, cwd: project });
    if (version.code !== 0 || version.stdout.trim() !== pkg.version) {
      throw new Error(`CLI --version returned "${version.stdout.trim()}", expected "${pkg.version}"`);
    }

    const models = await runNode([cli, 'models'], { env, cwd: project });
    if (models.code !== 0 || !models.stdout.includes('anthropic')) throw new Error('CLI models smoke test failed');

    const doctor = await runNode([cli, 'doctor'], { env, cwd: project });
    if (!doctor.stdout.includes('Workspace')) throw new Error('CLI doctor smoke test failed');

    console.log(`Smoke tests passed: --help, --version (${pkg.version}), models, doctor.`);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
    await rm(project, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
