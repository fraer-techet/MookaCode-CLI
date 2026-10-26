import type { ToolCall, Usage } from '@mookacode/protocol';
import type { ProviderManager } from './manager';
import { emptyUsage, type ProviderRequest, type ProviderRuntime } from './types';
import { isAbortError } from '../util/errors';

export interface CompletionResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: string;
}

export interface CompletionCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onUsage?: (usage: Usage) => void;
}

export async function runCompletion(
  manager: ProviderManager,
  runtime: ProviderRuntime,
  request: ProviderRequest,
  callbacks: CompletionCallbacks = {},
): Promise<CompletionResult> {
  let text = '';
  let reasoning = '';
  let usage = emptyUsage();
  let stopReason = 'end_turn';
  const calls = new Map<string, ToolCall>();

  for await (const event of manager.stream(runtime, request)) {
    switch (event.type) {
      case 'text':
        text += event.delta;
        callbacks.onText?.(event.delta);
        break;
      case 'reasoning':
        if (event.delta) {
          reasoning += event.delta;
          callbacks.onReasoning?.(event.delta);
        }
        break;
      case 'tool_call_start':
        if (!calls.has(event.id)) {
          calls.set(event.id, { id: event.id, name: event.name, arguments: {}, rawArguments: '' });
        }
        break;
      case 'tool_call_delta': {
        const call = calls.get(event.id);
        if (call) call.rawArguments = (call.rawArguments ?? '') + event.argumentsDelta;
        break;
      }
      case 'tool_call_end': {
        calls.set(event.id, {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          rawArguments: event.rawArguments,
        });
        break;
      }
      case 'usage': {
        const next: Usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.cacheReadTokens,
          cacheWriteTokens: event.usage.cacheWriteTokens,
        };
        if (
          next.cacheReadTokens === 0 &&
          next.cacheWriteTokens === 0 &&
          (runtime.provider.model.inputPricePerMillion !== undefined ||
            runtime.provider.model.outputPricePerMillion !== undefined)
        ) {
          const inputPrice = runtime.provider.model.inputPricePerMillion ?? 0;
          const outputPrice = runtime.provider.model.outputPricePerMillion ?? 0;
          next.costUsd = (next.inputTokens / 1_000_000) * inputPrice + (next.outputTokens / 1_000_000) * outputPrice;
        }
        usage = next;
        callbacks.onUsage?.(usage);
        break;
      }
      case 'done':
        stopReason = event.stopReason;
        break;
      case 'error':
        throw new Error(event.message);
    }
  }

  if (isAbortError(request.signal?.reason)) {
    throw request.signal?.reason;
  }

  return {
    text,
    reasoning,
    toolCalls: [...calls.values()],
    usage,
    stopReason,
  };
}
