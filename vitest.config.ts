import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8')) as { version: string };

export default defineConfig({
  define: {
    __MOOKACODE_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@mookacode/protocol': path.join(root, 'packages/protocol/src/index.ts'),
      '@mookacode/core': path.join(root, 'packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts'],
    testTimeout: 40_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
