import type { AgentMessage, ProviderStreamEvent } from '@mookacode/protocol';
import { ProviderError } from '../util/errors';
import type { ProviderAdapter, ProviderRequest, ProviderTool } from './types';
import { joinUrl, combineSignals, assertOk } from './http';
import { parseSse, readErrorBody } from './sse';

interface OpenAiDeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAiDeltaToolCall[];
    };
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAiDeltaToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

function toOpenAiMessages(system: string, messages: AgentMessage[]): unknown[] {
  const result: unknown[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const item: Record<string, unknown> = { role: 'assistant', content: message.content || null };
      if (message.toolCalls?.length) {
        item.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
        }));
      }
      result.push(item);
    } else if (message.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.isError ? `[tool error]\n${message.content}` : message.content,
      });
    } else {
      result.push({ role: 'user', content: message.content });
    }
  }
  return result;
}

function toOpenAiTools(tools: ProviderTool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export class OpenAiAdapter implements ProviderAdapter {
  readonly type = 'openai' as const;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly providerName: string;
  private readonly streamUsage: boolean;
  private readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';

  private readonly providerType: 'openai' | 'openai-compatible' | 'ollama';

  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    headers?: Record<string, string>;
    providerName: string;
    type?: 'openai' | 'openai-compatible' | 'ollama';
  }) {
    this.providerType = options.type ?? 'openai-compatible';
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.providerName = options.providerName;
    this.streamUsage = options.type === 'openai';
    this.maxTokensField = options.type === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model.providerModelId || request.model.id,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
      temperature: request.temperature,
      [this.maxTokensField]: request.maxOutputTokens,
      ...(request.model.extra ?? {}),
      ...(request.extra ?? {}),
    };
    if (request.tools.length > 0) {
      body.tools = toOpenAiTools(request.tools);
      body.tool_choice = 'auto';
    }
    if (this.streamUsage) body.stream_options = { include_usage: true };
    const requestEffort = request.effort && request.effort !== 'auto' ? request.effort : undefined;
    const supportsReasoningEffort = this.providerType === 'openai' && /^(o[1-9]|gpt-5)/i.test(request.model.id);
    if (requestEffort && (supportsReasoningEffort || request.model.extra?.supportsReasoningEffort === true)) {
      body.reasoning_effort = requestEffort;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.headers,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000);
    const { signal, cleanup } = combineSignals([request.signal, timeout]);

    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, 'chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      cleanup();
      if (request.signal?.aborted) throw error;
      if (timeout.aborted)
        throw new ProviderError('TIMEOUT', `${this.providerName}: request timed out.`, { retryable: true });
      throw new ProviderError(
        'NETWORK_ERROR',
        `${this.providerName}: cannot reach endpoint ${this.baseUrl}: ${(error as Error).message}`,
        {
          retryable: true,
          cause: error,
        },
      );
    }

    try {
      await assertOk(response, this.providerName);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const payload = (await response.json()) as OpenAiChunk;
        yield* this.emitNonStreaming(payload);
        return;
      }

      const pending = new Map<number, { id: string; name: string; args: string; started: boolean }>();
      let stopReason = 'end_turn';
      let usageEmitted = false;

      for await (const message of parseSse(response)) {
        if (message.data === '[DONE]') break;
        let chunk: OpenAiChunk;
        try {
          chunk = JSON.parse(message.data) as OpenAiChunk;
        } catch {
          continue;
        }
        if (chunk.error?.message) throw new ProviderError('PROVIDER_STREAM_ERROR', chunk.error.message);
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
              cacheWriteTokens: 0,
            },
          };
          usageEmitted = true;
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta;
          if (!delta) continue;
          if (delta.reasoning_content) yield { type: 'reasoning', delta: delta.reasoning_content };
          if (delta.reasoning) yield { type: 'reasoning', delta: delta.reasoning };
          if (typeof delta.content === 'string' && delta.content) {
            yield { type: 'text', delta: delta.content };
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            let entry = pending.get(index);
            if (!entry) {
              entry = {
                id: call.id || `call_${index}_${Date.now().toString(36)}`,
                name: '',
                args: '',
                started: false,
              };
              pending.set(index, entry);
            }
            if (call.id) entry.id = call.id;
            if (call.function?.name) {
              if (!entry.name) entry.name = call.function.name;
              else if (call.function.name !== entry.name && !entry.name.endsWith(call.function.name)) {
                entry.name += call.function.name;
              }
            }
            if (!entry.started && (entry.name || call.function?.arguments)) {
              entry.started = true;
              yield { type: 'tool_call_start', id: entry.id, name: entry.name || 'unknown_tool', index };
            }
            if (call.function?.arguments) {
              entry.args += call.function.arguments;
              yield { type: 'tool_call_delta', id: entry.id, index, argumentsDelta: call.function.arguments };
            }
          }
          if (choice.finish_reason) stopReason = choice.finish_reason;
        }
      }

      for (const [index, call] of pending) {
        const raw = call.args || '{}';
        let parsed: Record<string, unknown> = {};
        try {
          const value = JSON.parse(raw) as unknown;
          if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          // The core validates the empty arguments and reports a useful error.
        }
        yield {
          type: 'tool_call_end',
          id: call.id,
          index,
          name: call.name || 'unknown_tool',
          arguments: parsed,
          rawArguments: raw,
        };
      }
      if (!usageEmitted) {
        yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      }
      yield { type: 'done', stopReason };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal?.aborted) throw error;
      throw new ProviderError(
        'STREAM_INTERRUPTED',
        `${this.providerName}: streaming response was interrupted: ${(error as Error).message}`,
        {
          retryable: true,
          cause: error,
        },
      );
    } finally {
      cleanup();
    }
  }

  private *emitNonStreaming(payload: OpenAiChunk): Generator<ProviderStreamEvent> {
    if (payload.error?.message) throw new ProviderError('PROVIDER_ERROR', payload.error.message);
    const choice = payload.choices?.[0];
    const message = choice?.message;
    const delta = choice?.delta;
    const content = message?.content ?? delta?.content;
    const reasoning = message?.reasoning_content ?? message?.reasoning ?? delta?.reasoning_content ?? delta?.reasoning;
    const toolCalls = message?.tool_calls ?? delta?.tool_calls ?? [];
    if (content) yield { type: 'text', delta: content };
    if (reasoning) yield { type: 'reasoning', delta: reasoning };
    for (const call of toolCalls) {
      const id = call.id || `call_${call.index ?? 0}`;
      const name = call.function?.name || 'unknown_tool';
      const raw = call.function?.arguments || '{}';
      yield { type: 'tool_call_start', id, name, index: call.index ?? 0 };
      if (raw !== '{}') yield { type: 'tool_call_delta', id, index: call.index ?? 0, argumentsDelta: raw };
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      yield {
        type: 'tool_call_end',
        id,
        index: call.index ?? 0,
        name,
        arguments: parsed,
        rawArguments: raw,
      };
    }
    if (payload.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: payload.usage.prompt_tokens ?? 0,
          outputTokens: payload.usage.completion_tokens ?? 0,
          cacheReadTokens: payload.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
        },
      };
    }
    yield { type: 'done', stopReason: choice?.finish_reason ?? 'end_turn' };
  }
}

export async function fetchOpenAiModels(
  baseUrl: string,
  apiKey: string | undefined,
  headers?: Record<string, string>,
): Promise<string[]> {
  const response = await fetch(joinUrl(baseUrl, 'models'), {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new ProviderError('MODELS_UNAVAILABLE', await readErrorBody(response), { status: response.status });
  }
  const data = (await response.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id));
}
