import type { MookaConfig, ProviderConfig, ProviderModelView, ProviderStreamEvent } from '@mookacode/protocol';
import type { ModelConfig } from '@mookacode/protocol';
import { CredentialStore } from '../auth/store';
import { MookaError, ProviderError, isAbortError } from '../util/errors';
import { sleep } from '../util/sleep';
import { AnthropicAdapter } from './anthropic';
import { OpenAiAdapter, fetchOpenAiModels } from './openai';
import type { ProviderAdapter, ProviderRequest, ProviderRuntime } from './types';

export class ProviderManager {
  private readonly config: MookaConfig;
  private readonly credentials: CredentialStore;
  private readonly keyCache = new Map<string, { key?: string; source: 'env' | 'store' | 'none' }>();

  constructor(config: MookaConfig, credentials = new CredentialStore()) {
    this.config = config;
    this.credentials = credentials;
  }

  setConfig(config: MookaConfig): void {
    Object.assign(this.config, config);
  }

  clearKeyCache(): void {
    this.keyCache.clear();
  }

  getProvider(id: string): ProviderConfig {
    const provider = this.config.providers.find((item) => item.id === id);
    if (!provider) {
      throw new MookaError('PROVIDER_NOT_FOUND', `Provider "${id}" does not exist. Run "mookacode providers list".`);
    }
    return provider;
  }

  async resolve(providerId?: string, modelId?: string): Promise<ProviderRuntime> {
    let provider = providerId
      ? this.getProvider(providerId)
      : this.config.providers.find((p) => p.id === this.config.defaultProvider);
    if (!provider) throw new MookaError('PROVIDER_NOT_FOUND', 'No provider configured.');
    let model: ModelConfig | undefined;
    if (modelId) {
      model = provider.models.find((item) => item.id === modelId || item.providerModelId === modelId);
      if (!model && !providerId) {
        const owner = this.config.providers.find((item) =>
          item.models.some((candidate) => candidate.id === modelId || candidate.providerModelId === modelId),
        );
        if (owner) {
          provider = owner;
          model = owner.models.find((item) => item.id === modelId || item.providerModelId === modelId);
        }
      }
      if (!model) {
        throw new MookaError(
          'MODEL_NOT_FOUND',
          `Model "${modelId}" is not configured for provider "${provider.id}". Run "mookacode models" or add it to the provider.`,
        );
      }
    } else {
      model =
        provider.models.find((item) => item.id === this.config.defaultModel) ??
        provider.models.find((item) => item.id === provider!.defaultModel) ??
        provider.models[0];
      if (!model) throw new MookaError('MODEL_NOT_CONFIGURED', `Provider "${provider.id}" has no models.`);
    }

    let key: string | undefined;
    let source: 'env' | 'store' | 'none' = 'none';
    if (provider.type === 'anthropic' || provider.type === 'openai' || provider.type === 'openai-compatible') {
      let cached = this.keyCache.get(provider.id);
      if (!cached) {
        const resolution = await this.credentials.resolve(provider);
        cached = { key: resolution.key, source: resolution.source };
        this.keyCache.set(provider.id, cached);
      }
      key = cached.key;
      source = cached.source;
      if (!key && (provider.type === 'anthropic' || provider.type === 'openai')) {
        const command = `mookacode auth set ${provider.id}`;
        throw new ProviderError(
          'MISSING_API_KEY',
          `${provider.name} has no API key. Run "${command}" or set ${provider.apiKeyEnv || 'the API key environment variable'}.`,
        );
      }
    }
    const baseUrl = provider.baseUrl || defaultBaseUrl(provider.type);
    const adapter = this.createAdapter(provider, model, baseUrl, key);
    return {
      provider: { config: provider, model, apiKey: key, keySource: source },
      adapter,
      timeoutMs: provider.timeoutMs ?? 120_000,
      maxRetries: provider.maxRetries ?? 2,
    };
  }

  private createAdapter(
    provider: ProviderConfig,
    model: ModelConfig,
    baseUrl: string,
    apiKey?: string,
  ): ProviderAdapter {
    if (provider.type === 'anthropic') {
      if (!apiKey) throw new ProviderError('MISSING_API_KEY', `${provider.name}: API key is required.`);
      return new AnthropicAdapter({
        baseUrl,
        apiKey,
        headers: provider.headers,
        providerName: provider.name,
      });
    }
    if (provider.type === 'ollama' && !model.supportsTools) {
      throw new MookaError(
        'MODEL_TOOLS_UNSUPPORTED',
        `Model "${model.id}" is marked as not supporting tool calls. Use a tool-capable model such as qwen2.5-coder, or update the model capabilities.`,
      );
    }
    return new OpenAiAdapter({
      baseUrl,
      apiKey,
      headers: provider.headers,
      providerName: provider.name,
      type: provider.type,
    });
  }

  validateCapabilities(runtime: ProviderRuntime, request: { tools: unknown[]; streaming: boolean }): void {
    const { model, config } = runtime.provider;
    if (request.tools.length > 0 && model.supportsTools === false) {
      throw new MookaError(
        'MODEL_TOOLS_UNSUPPORTED',
        `${config.name}/${model.id} is configured as not supporting tool calling. The agent needs tools. Enable capabilities if the endpoint actually supports them.`,
      );
    }
    if (request.streaming && model.supportsStreaming === false) {
      throw new MookaError(
        'MODEL_STREAMING_UNSUPPORTED',
        `${config.name}/${model.id} is configured as not supporting streaming.`,
      );
    }
  }

  async *stream(runtime: ProviderRuntime, request: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    let attempt = 0;
    let emitted = false;
    const effectiveRequest: ProviderRequest = { ...request, timeoutMs: request.timeoutMs ?? runtime.timeoutMs };
    while (true) {
      try {
        for await (const event of runtime.adapter.stream(effectiveRequest)) {
          emitted = true;
          if (event.type === 'error') {
            throw new ProviderError('PROVIDER_STREAM_ERROR', event.message, { retryable: event.retryable });
          }
          yield event;
          if (event.type === 'done') return;
        }
        return;
      } catch (error) {
        if (isAbortError(error) || request.signal?.aborted) throw error;
        const retryable = error instanceof MookaError ? error.retryable : false;
        if (emitted || !retryable || attempt >= runtime.maxRetries) throw error;
        attempt++;
        const delay = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await sleep(delay, request.signal);
      }
    }
  }

  listModels(keyStatus?: Map<string, 'env' | 'store' | 'none'>): ProviderModelView[] {
    const models: ProviderModelView[] = [];
    for (const provider of this.config.providers) {
      const keySource = keyStatus?.get(provider.id) ?? (provider.type === 'ollama' ? 'none' : 'none');
      for (const model of provider.models) {
        models.push({
          ...model,
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.type,
          configured: provider.type === 'ollama' || provider.type === 'openai-compatible' || keySource !== 'none',
          keySource,
          default: provider.id === this.config.defaultProvider && model.id === this.config.defaultModel,
        });
      }
    }
    return models;
  }

  async keyStatus(): Promise<Map<string, 'env' | 'store' | 'none'>> {
    const map = new Map<string, 'env' | 'store' | 'none'>();
    for (const provider of this.config.providers) {
      if (provider.type === 'ollama') {
        map.set(provider.id, 'none');
        continue;
      }
      try {
        const resolution = await this.credentials.resolve(provider);
        map.set(provider.id, resolution.source);
      } catch {
        map.set(provider.id, 'none');
      }
    }
    return map;
  }

  async probe(providerId: string, modelId?: string): Promise<{ ok: boolean; message: string; models?: string[] }> {
    const provider = this.getProvider(providerId);
    const key = await this.credentials.resolve(provider);
    if ((provider.type === 'anthropic' || provider.type === 'openai') && !key.key) {
      return { ok: false, message: `No API key configured. Run "mookacode auth set ${provider.id}".` };
    }
    const baseUrl = provider.baseUrl || defaultBaseUrl(provider.type);
    try {
      if (provider.type === 'anthropic') {
        const model = modelId || provider.models[0]?.id;
        if (!model) return { ok: false, message: 'No model configured for provider.' };
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': key.key!,
            ...(provider.headers ?? {}),
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'reply with ok' }],
          }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          const body = await response.text();
          return { ok: false, message: `HTTP ${response.status}: ${body.slice(0, 500)}` };
        }
        return { ok: true, message: `Connected to Anthropic endpoint and verified model "${model}".` };
      }
      const models = await fetchOpenAiModels(baseUrl, key.key, provider.headers);
      return {
        ok: true,
        message: `Connected. Endpoint reported ${models.length} model(s).`,
        models,
      };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }
}

function defaultBaseUrl(type: ProviderConfig['type']): string {
  if (type === 'anthropic') return 'https://api.anthropic.com';
  if (type === 'ollama') return 'http://127.0.0.1:11434/v1';
  return 'https://api.openai.com/v1';
}
