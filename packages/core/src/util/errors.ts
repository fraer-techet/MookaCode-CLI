export class MookaError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { details?: unknown; retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'MookaError';
    this.code = code;
    this.details = options?.details;
    this.retryable = options?.retryable ?? false;
  }
}

export class CancelledError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export class PermissionDeniedError extends MookaError {
  constructor(message: string, details?: unknown) {
    super('PERMISSION_DENIED', message, { details });
    this.name = 'PermissionDeniedError';
  }
}

export class ProviderError extends MookaError {
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options?: { status?: number; details?: unknown; retryable?: boolean; cause?: unknown },
  ) {
    super(code, message, options);
    this.name = 'ProviderError';
    this.status = options?.status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function classifyError(error: unknown): { retryable: boolean; message: string } {
  if (error instanceof MookaError) return { retryable: error.retryable, message: error.message };
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      retryable: code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET',
      message: error.message,
    };
  }
  return { retryable: false, message: errorMessage(error) };
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof Error && error.message.toLowerCase().includes('aborted'))
  );
}
