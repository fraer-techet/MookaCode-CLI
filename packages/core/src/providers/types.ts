import type {
  AgentMessage,
  Effort,
  ModelConfig,
  ProviderConfig,
  ProviderStreamEvent,
  Usage,
} from '@mookacode/protocol';

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  model: ModelConfig;
  system: string;
  messages: AgentMessage[];
  tools: ProviderTool[];
  temperature: number;
  maxOutputTokens: number;
  promptCaching: boolean;
  effort?: Effort;
  timeoutMs?: number;
  signal?: AbortSignal;
  extra?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly type: ProviderConfig['type'];
  stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent>;
}

export interface ResolvedProvider {
  config: ProviderConfig;
  model: ModelConfig;
  apiKey?: string;
  keySource: 'env' | 'store' | 'none';
}

export interface ProviderRuntime {
  provider: ResolvedProvider;
  adapter: ProviderAdapter;
  timeoutMs: number;
  maxRetries: number;
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
    costUsd: a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
