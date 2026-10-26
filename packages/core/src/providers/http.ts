import { ProviderError } from '../util/errors';
import { redactSecrets } from '../util/redact';
import { readErrorBody } from './sse';

export function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

export function providerHttpError(status: number, body: string, providerName: string): ProviderError {
  const safeBody = redactSecrets(body);
  const lower = safeBody.toLowerCase();
  if (status === 401 || status === 403) {
    return new ProviderError(
      'AUTH_FAILED',
      `${providerName}: authentication failed (${status}). Check the API key with "mookacode auth set ${providerName.toLowerCase()}".`,
      { status, details: safeBody, retryable: false },
    );
  }
  if (status === 404 && /model|not found/.test(lower)) {
    return new ProviderError(
      'MODEL_NOT_FOUND',
      `${providerName}: model was not found. Run "mookacode models" or update the provider model configuration.`,
      { status, details: safeBody, retryable: false },
    );
  }
  if (status === 429) {
    return new ProviderError(
      'RATE_LIMITED',
      `${providerName}: rate limit or quota exceeded. Try again later or choose another model.`,
      {
        status,
        details: safeBody,
        retryable: true,
      },
    );
  }
  if (status >= 500) {
    return new ProviderError(
      'PROVIDER_UNAVAILABLE',
      `${providerName}: upstream error ${status}. The provider may be temporarily unavailable.`,
      {
        status,
        details: safeBody,
        retryable: true,
      },
    );
  }
  return new ProviderError(
    'PROVIDER_REQUEST_FAILED',
    `${providerName}: API error ${status}: ${safeBody.slice(0, 800)}`,
    {
      status,
      details: safeBody,
      retryable: false,
    },
  );
}

export async function assertOk(response: Response, providerName: string): Promise<void> {
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw providerHttpError(response.status, body, providerName);
  }
}

export function combineSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = (signal: AbortSignal) => () => controller.abort(signal.reason);
  const listeners: Array<{ signal: AbortSignal; fn: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const fn = onAbort(signal);
    signal.addEventListener('abort', fn, { once: true });
    listeners.push({ signal, fn });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) listener.signal.removeEventListener('abort', listener.fn);
    },
  };
}
