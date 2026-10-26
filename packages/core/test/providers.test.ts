import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../src/providers/anthropic';
import type { ProviderStreamEvent } from '@mookacode/protocol';

let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeServer?.();
  closeServer = null;
});

describe('Anthropic streaming adapter', () => {
  it('parses text, tool use, cache usage and stop reason from SSE', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        expect(req.headers['x-api-key']).toBe('test-key');
        expect(req.headers['anthropic-version']).toBe('2023-06-01');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = (name: string, data: unknown) => {
          res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        event('message_start', {
          type: 'message_start',
          message: { usage: { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } },
        });
        event('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello ' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'world' },
        });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
        event('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_01', name: 'write_file', input: {} },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt",' },
        });
        event('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"content":"ok"}' },
        });
        event('content_block_stop', { type: 'content_block_stop', index: 1 });
        event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 15, cache_read_input_tokens: 4 },
        });
        event('message_stop', { type: 'message_stop' });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const adapter = new AnthropicAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      providerName: 'Anthropic test',
    });
    const events: ProviderStreamEvent[] = [];
    for await (const event of adapter.stream({
      model: {
        id: 'claude-test',
        supportsTools: true,
        supportsStreaming: true,
        supportsPromptCaching: true,
      },
      system: 'system',
      messages: [{ id: 'u1', role: 'user', content: 'write a file', createdAt: Date.now() }],
      tools: [{ name: 'write_file', description: 'write', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxOutputTokens: 512,
      promptCaching: true,
    })) {
      events.push(event);
    }
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => event.delta)
        .join(''),
    ).toBe('Hello world');
    const tool = events.find((event) => event.type === 'tool_call_end');
    expect(tool).toMatchObject({
      type: 'tool_call_end',
      name: 'write_file',
      arguments: { path: 'a.txt', content: 'ok' },
    });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 15, cacheReadTokens: 4, cacheWriteTokens: 2 },
    });
    expect(events.find((event) => event.type === 'done')).toMatchObject({ stopReason: 'tool_use' });
    expect(requestBody).not.toBeNull();
    expect((requestBody as unknown as { stream: boolean }).stream).toBe(true);
  });
});
