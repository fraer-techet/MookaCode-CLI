import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Replaces the placeholder repository slug everywhere it is referenced.
 *
 *   node scripts/set-repo.mjs owner/repo
 */

const PLACEHOLDER = 'fraer-techet/mookacode';
const root = path.resolve(import.meta.dirname, '..');

const slug = (process.argv[2] ?? '')
  .trim()
  .replace(/^https?:\/\/github\.com\//i, '')
  .replace(/\.git$/, '');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
  console.error('usage: node scripts/set-repo.mjs owner/repo');
  process.exit(1);
}

const skip = new Set(['.workbuddy-ai', '.git', 'node_modules', 'dist', 'coverage']);
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.split('/').some((part) => skip.has(part)))
  .filter((file) => /\.(md|json|yml|yaml|sh|ps1|mjs|ts)$/.test(file));

const changed = [];
for (const file of files) {
  const full = path.join(root, file);
  const before = await readFile(full, 'utf8');
  if (!before.includes(PLACEHOLDER)) continue;
  const after = before.split(PLACEHOLDER).join(slug);
  await writeFile(full, after);
  changed.push(file);
}

if (!changed.length) {
  console.log(`No references to ${PLACEHOLDER} left.`);
} else {
  console.log(`Set repository slug to ${slug} in ${changed.length} files:`);
  for (const file of changed) console.log(`  ${file}`);
  console.log('\nReview the diff, then commit: git commit -am "chore: point the repository at ' + slug + '"');
}
