import type { AgentMessage, ProviderStreamEvent } from '@mookacode/protocol';
import { ProviderError } from '../util/errors';
import type { ProviderAdapter, ProviderRequest, ProviderTool } from './types';
import { assertOk, combineSignals, joinUrl } from './http';
import { parseSse } from './sse';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: {
    output_tokens?: number;
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { type?: string; message?: string };
}

function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const result: unknown[] = [];
  let toolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (toolResults.length) {
      result.push({ role: 'user', content: toolResults });
      toolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.isError ? `[tool error]\n${message.content}` : message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flushToolResults();
    if (message.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      if (content.length > 0) result.push({ role: 'assistant', content });
    } else {
      result.push({ role: 'user', content: [{ type: 'text', text: message.content }] });
    }
  }
  flushToolResults();
  return result;
}

function toAnthropicTools(tools: ProviderTool[], promptCaching: boolean): unknown[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(promptCaching && index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly type = 'anthropic' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly providerName: string;

  constructor(options: { baseUrl: string; apiKey: string; headers?: Record<string, string>; providerName: string }) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.providerName = options.providerName;
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const system = request.promptCaching
      ? [
          {
            type: 'text',
            text: request.system,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : request.system;
    const body: Record<string, unknown> = {
      model: request.model.providerModelId || request.model.id,
      system,
      messages: toAnthropicMessages(request.messages),
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      stream: true,
      ...(request.model.extra ?? {}),
      ...(request.extra ?? {}),
    };
    if (request.tools.length) {
      body.tools = toAnthropicTools(request.tools, request.promptCaching);
    }
    const requestEffort = request.effort && request.effort !== 'auto' ? request.effort : undefined;
    if (requestEffort && request.model.extra?.supportsThinking === true) {
      const budgets = { low: 2048, medium: 8192, high: 16_384 } as const;
      const budget = budgets[requestEffort];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(request.maxOutputTokens, budget + 1024);
    }

    const timeout = AbortSignal.timeout(request.timeoutMs ?? 120_000);
    const { signal, cleanup } = combineSignals([request.signal, timeout]);
    let response: Response;
    try {
      response = await fetch(joinUrl(this.baseUrl, 'v1/messages'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': '2023-06-01',
          'x-api-key': this.apiKey,
          ...this.headers,
        },
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
        `${this.providerName}: cannot reach ${this.baseUrl}: ${(error as Error).message}`,
        {
          retryable: true,
          cause: error,
        },
      );
    }

    try {
      await assertOk(response, this.providerName);
      const pendingTools = new Map<number, { id: string; name: string; json: string }>();
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let stopReason = 'end_turn';

      for await (const message of parseSse(response)) {
        let event: AnthropicEvent;
        try {
          event = JSON.parse(message.data) as AnthropicEvent;
        } catch {
          continue;
        }
        if (event.type === 'error') {
          throw new ProviderError('PROVIDER_STREAM_ERROR', event.error?.message ?? 'Anthropic stream error');
        }
        if (event.type === 'message_start') {
          const usage = event.message?.usage;
          inputTokens = usage?.input_tokens ?? 0;
          cacheRead = usage?.cache_read_input_tokens ?? 0;
          cacheWrite = usage?.cache_creation_input_tokens ?? 0;
          outputTokens = usage?.output_tokens ?? 0;
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use' && event.index !== undefined) {
            const id = block.id || `tool_${event.index}`;
            const name = block.name || 'unknown_tool';
            pendingTools.set(event.index, {
              id,
              name,
              json: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '',
            });
            yield { type: 'tool_call_start', id, name, index: event.index };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text', delta: delta.text };
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            yield { type: 'reasoning', delta: delta.thinking };
          } else if (delta?.type === 'input_json_delta' && delta.partial_json && event.index !== undefined) {
            const tool = pendingTools.get(event.index);
            if (tool) {
              tool.json += delta.partial_json;
              yield {
                type: 'tool_call_delta',
                id: tool.id,
                index: event.index,
                argumentsDelta: delta.partial_json,
              };
            }
          }
        } else if (event.type === 'content_block_stop' && event.index !== undefined) {
          const tool = pendingTools.get(event.index);
          if (tool) {
            const raw = tool.json || '{}';
            let parsed: Record<string, unknown> = {};
            try {
              const value = JSON.parse(raw) as unknown;
              if (value && typeof value === 'object' && !Array.isArray(value))
                parsed = value as Record<string, unknown>;
            } catch {
              // Core turns invalid tool input into a structured tool error.
            }
            yield {
              type: 'tool_call_end',
              id: tool.id,
              index: event.index,
              name: tool.name,
              arguments: parsed,
              rawArguments: raw,
            };
            pendingTools.delete(event.index);
          }
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          cacheRead = event.usage?.cache_read_input_tokens ?? cacheRead;
          cacheWrite = event.usage?.cache_creation_input_tokens ?? cacheWrite;
        }
      }

      yield {
        type: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        },
      };
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
}
