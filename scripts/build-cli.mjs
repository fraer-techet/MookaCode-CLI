import { build } from 'esbuild';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkgDir = path.join(root, 'packages', 'cli');
const outfile = path.join(pkgDir, 'dist', 'mookacode.cjs');
const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));

await mkdir(path.dirname(outfile), { recursive: true });
const started = Date.now();
const result = await build({
  entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
  define: { __MOOKACODE_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});
if (result.errors.length) process.exit(1);

// npm only picks up LICENSE/README from the package directory itself, and the
// release artifact should carry the license next to the bundle.
await copyFile(path.join(root, 'LICENSE'), path.join(pkgDir, 'LICENSE'));
await chmod(outfile, 0o755).catch(() => {
  // Windows has no executable bit; ignore.
});

console.log(`CLI built: ${path.relative(root, outfile)} v${pkg.version} (${Date.now() - started}ms)`);
