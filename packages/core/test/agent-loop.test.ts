import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MookaCore } from '@mookacode/core';
import type { AgentEvent, PermissionRequest } from '@mookacode/protocol';
import {
  FakeOpenAiServer,
  cleanupDir,
  errorResponse,
  finishText,
  finishToolCall,
  tempDir,
  testProvider,
} from './helpers/fake-openai';

let home = '';
let project = '';
let server: FakeOpenAiServer;
let core: MookaCore | null = null;

beforeEach(async () => {
  home = await tempDir('home');
  project = await tempDir('project');
  process.env.MOOKACODE_HOME = home;
  process.env.MOOKA_TEST_API_KEY = 'test-key';
  server = new FakeOpenAiServer();
});

afterEach(async () => {
  await core?.close().catch(() => undefined);
  core = null;
  await server.close();
  await cleanupDir(home);
  await cleanupDir(project);
  delete process.env.MOOKACODE_HOME;
  delete process.env.MOOKA_TEST_API_KEY;
});

describe('agent loop', () => {
  it('runs a real streamed tool call, creates a file, records the session and diff metadata', async () => {
    await server.start((request, index, response) => {
      expect(request.body.stream).toBe(true);
      expect(Array.isArray(request.body.tools)).toBe(true);
      if (index === 0) {
        finishToolCall(response, {
          id: 'call_write_1',
          name: 'write_file',
          arguments: { path: 'hello.txt', content: 'hello from mooka\n' },
        });
      } else {
        finishText(response, 'Created `hello.txt` and it is ready.', { inputTokens: 55, outputTokens: 12 });
      }
    });
    core = await MookaCore.create({ cwd: project });
    await core.updateConfig({
      agent: { ...core.config.agent, verifyAfterEdit: false, autoCheckpoint: false },
      context: { ...core.config.context, maxInputTokens: 48_000 },
    });
    await core.addProvider(testProvider(server.url), true);

    const events: AgentEvent[] = [];
    let permission: PermissionRequest | null = null;
    const result = await core.runAgent(
      {
        task: 'Create hello.txt with a greeting',
        mode: 'build',
        provider: 'fake',
        model: 'fake-model',
        requestPermission: async (request) => {
          permission = request;
          return { id: request.id, approved: true };
        },
      },
      (event) => events.push(event),
    );

    expect(result.status).toBe('completed');
    expect(permission).not.toBeNull();
    expect(await readFile(path.join(project, 'hello.txt'), 'utf8')).toBe('hello from mooka\n');
    expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
    expect(events.some((event) => event.type === 'run.completed')).toBe(true);
    expect(result.changedFiles).toContainEqual(expect.objectContaining({ path: 'hello.txt', kind: 'created' }));
    expect(result.usage.outputTokens).toBeGreaterThan(0);

    const sessions = await core.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('completed');
    const record = await core.getSession(sessions[0]!.id);
    expect(record?.messages.some((message) => message.role === 'tool' && message.toolName === 'write_file')).toBe(true);
    const secondRequest = server.requests[1];
    expect(Array.isArray(secondRequest?.body.messages)).toBe(true);
    const messages = secondRequest?.body.messages as Array<{ role: string }>;
    expect(messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('denies a write when the permission callback rejects it', async () => {
    await server.start((_request, index, response) => {
      if (index === 0) {
        finishToolCall(response, {
          id: 'call_write_denied',
          name: 'write_file',
          arguments: { path: 'forbidden.txt', content: 'nope' },
        });
      } else {
        finishText(response, 'The write was denied, so I did not create the file.');
      }
    });
    core = await MookaCore.create({ cwd: project });
    await core.updateConfig({
      agent: { ...core.config.agent, verifyAfterEdit: false, autoCheckpoint: false },
    });
    await core.addProvider(testProvider(server.url), true);

    const events: AgentEvent[] = [];
    let requested = false;
    const result = await core.runAgent(
      {
        task: 'Create forbidden.txt',
        mode: 'build',
        provider: 'fake',
        model: 'fake-model',
        requestPermission: async (request) => {
          requested = true;
          return { id: request.id, approved: false, reason: 'test denial' };
        },
      },
      (event) => events.push(event),
    );
    expect(result.status).toBe('completed');
    await expect(readFile(path.join(project, 'forbidden.txt'), 'utf8')).rejects.toThrow();
    expect(requested).toBe(true);
    expect(events.some((event) => event.type === 'tool.failed')).toBe(true);
  });

  it('reports provider authentication errors and leaves a resumable session', async () => {
    await server.start((_request, _index, response) => errorResponse(response, 401, 'invalid api key'));
    core = await MookaCore.create({ cwd: project });
    await core.updateConfig({ agent: { ...core.config.agent, verifyAfterEdit: false, autoCheckpoint: false } });
    await core.addProvider(testProvider(server.url), true);
    const events: AgentEvent[] = [];
    const result = await core.runAgent(
      {
        task: 'Do something',
        mode: 'build',
        provider: 'fake',
        model: 'fake-model',
        requestPermission: async (request) => ({ id: request.id, approved: true }),
      },
      (event) => events.push(event),
    );
    expect(result.status).toBe('failed');
    expect(events.some((event) => event.type === 'run.failed')).toBe(true);
    const sessions = await core.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('interrupted');
    const record = await core.getSession(sessions[0]!.id);
    expect(record?.pendingTask).toBe('Do something');
  });

  it('supports cancellation and marks the session interrupted', async () => {
    await server.start((_request, _index, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'Start' }, finish_reason: null }] })}\n\n`,
      );
      const timer = setInterval(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '…' }, finish_reason: null }] })}\n\n`);
      }, 60);
      response.on('close', () => clearInterval(timer));
    });
    core = await MookaCore.create({ cwd: project });
    await core.updateConfig({ agent: { ...core.config.agent, verifyAfterEdit: false, autoCheckpoint: false } });
    await core.addProvider(testProvider(server.url), true);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const running = core.runAgent(
      {
        task: 'A long task',
        mode: 'build',
        provider: 'fake',
        model: 'fake-model',
        signal: controller.signal,
        requestPermission: async (request) => ({ id: request.id, approved: true }),
      },
      (event) => events.push(event),
    );
    setTimeout(() => controller.abort(), 180);
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(events.some((event) => event.type === 'run.cancelled')).toBe(true);
    const sessions = await core.listSessions();
    expect(sessions[0]?.status).toBe('interrupted');
    const record = await core.getSession(sessions[0]!.id);
    expect(record?.pendingTask).toBe('A long task');
  });

  it('edits an existing file with a precise patch and returns a unified diff', async () => {
    await writeFile(path.join(project, 'app.ts'), 'export const value = 1;\n', 'utf8');
    await server.start((_request, index, response) => {
      if (index === 0) {
        finishToolCall(response, {
          id: 'call_read',
          name: 'read_file',
          arguments: { path: 'app.ts' },
        });
      } else if (index === 1) {
        finishToolCall(response, {
          id: 'call_edit',
          name: 'edit_file',
          arguments: { path: 'app.ts', oldString: 'value = 1', newString: 'value = 2' },
        });
      } else {
        finishText(response, 'Updated the value to 2.');
      }
    });
    core = await MookaCore.create({ cwd: project });
    await core.updateConfig({ agent: { ...core.config.agent, verifyAfterEdit: false, autoCheckpoint: false } });
    await core.addProvider(testProvider(server.url), true);
    const toolResults: string[] = [];
    const result = await core.runAgent(
      {
        task: 'Change value to 2',
        mode: 'build',
        provider: 'fake',
        model: 'fake-model',
        requestPermission: async (request) => {
          toolResults.push(request.tool);
          return { id: request.id, approved: true };
        },
      },
      () => undefined,
    );
    expect(result.status).toBe('completed');
    expect(await readFile(path.join(project, 'app.ts'), 'utf8')).toBe('export const value = 2;\n');
    expect(toolResults).toContain('edit_file');
    const record = await core.getSession(result.sessionId);
    const editMessage = record?.messages.find((message) => message.role === 'tool' && message.toolName === 'edit_file');
    expect(editMessage?.content).toContain('+1 -1');
    expect(editMessage?.content).toContain('@@');
  });
});
