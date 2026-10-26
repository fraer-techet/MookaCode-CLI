import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MookaConfig, ProviderConfig } from '@mookacode/protocol';

export interface FakeRequest {
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
}

export class FakeOpenAiServer {
  readonly requests: FakeRequest[] = [];
  private server: Server | null = null;
  private handler: (request: FakeRequest, index: number, response: ServerResponse) => void = () => undefined;
  url = '';

  async start(handler: (request: FakeRequest, index: number, response: ServerResponse) => void): Promise<string> {
    this.handler = handler;
    this.server = createServer((req, res) => this.onRequest(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Could not bind fake server');
    this.url = `http://127.0.0.1:${address.port}/v1`;
    return this.url;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = { raw: body };
      }
      const request: FakeRequest = { body: parsed, headers: req.headers };
      this.requests.push(request);
      this.handler(request, this.requests.length - 1, res);
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }
}

export function sseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

export function sseData(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function textChunks(text: string, size = 5): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

export function finishText(
  response: ServerResponse,
  text: string,
  options: { inputTokens?: number; outputTokens?: number } = {},
): void {
  sseHeaders(response);
  sseData(response, { choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (const chunk of textChunks(text)) {
    sseData(response, { choices: [{ delta: { content: chunk }, finish_reason: null }] });
  }
  sseData(response, {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: options.inputTokens ?? 30,
      completion_tokens: options.outputTokens ?? 10,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

export function finishToolCall(
  response: ServerResponse,
  call: { id: string; name: string; arguments: Record<string, unknown> },
  options: { inputTokens?: number; outputTokens?: number } = {},
): void {
  sseHeaders(response);
  const raw = JSON.stringify(call.arguments);
  const midpoint = Math.max(1, Math.floor(raw.length / 2));
  sseData(response, {
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }],
        },
        finish_reason: null,
      },
    ],
  });
  sseData(response, {
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(0, midpoint) } }] }, finish_reason: null },
    ],
  });
  sseData(response, {
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(midpoint) } }] }, finish_reason: null },
    ],
  });
  sseData(response, {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: {
      prompt_tokens: options.inputTokens ?? 40,
      completion_tokens: options.outputTokens ?? 8,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

export function errorResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message } }));
}

export function testProvider(baseUrl: string): ProviderConfig {
  return {
    id: 'fake',
    name: 'Fake OpenAI',
    type: 'openai-compatible',
    baseUrl,
    apiKeyEnv: 'MOOKA_TEST_API_KEY',
    apiKeyRef: 'fake',
    timeoutMs: 10_000,
    maxRetries: 0,
    models: [
      {
        id: 'fake-model',
        providerModelId: 'fake-model',
        name: 'Fake Model',
        contextWindow: 64_000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ],
  };
}

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `mookacode-${prefix}-`));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}

export function projectConfig(overrides: Partial<MookaConfig> = {}): Partial<MookaConfig> {
  return overrides;
}
