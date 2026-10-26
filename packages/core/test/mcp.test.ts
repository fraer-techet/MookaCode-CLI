import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { MookaCore } from '@mookacode/core';
import { cleanupDir, tempDir } from './helpers/fake-openai';

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

describe('MCP', () => {
  it('connects to a real stdio MCP server, lists tools and calls one', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url));
    core = await MookaCore.create({ cwd: project });
    await core.updateConfig({
      mcpServers: [
        {
          id: 'mock',
          name: 'Mock MCP',
          transport: 'stdio',
          command: process.execPath,
          args: [fixture],
          enabled: true,
          timeoutMs: 15_000,
        },
      ],
    });
    const statuses = await core.mcpStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.connected).toBe(true);
    expect(statuses[0]?.tools).toBeGreaterThanOrEqual(2);
    const definitions = core.mcp.toolDefinitions();
    const echo = definitions.find((tool) => tool.name === 'mcp__mock__echo');
    expect(echo).toBeDefined();
    const result = await core.mcp.call('mock', 'echo', { text: 'hello' });
    expect(JSON.stringify(result)).toContain('echo:hello');
  });
});
