// Retry policies for broker SDK calls

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableCodes?: string[];
}

const DEFAULT_RETRYABLE = ['TIMEOUT', 'RATE_LIMIT', 'NETWORK', '503', '502', '429'];

export function isRetryableError(errorCode?: string, message?: string): boolean {
  if (!errorCode && !message) return false;
  const hay = `${errorCode ?? ''} ${message ?? ''}`.toUpperCase();
  return DEFAULT_RETRYABLE.some((c) => hay.includes(c));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? Number(process.env.BROKER_RETRY_MAX ?? 3);
  const baseDelay = opts.baseDelayMs ?? Number(process.env.BROKER_RETRY_BASE_MS ?? 500);
  const maxDelay = opts.maxDelayMs ?? 5000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const code = err instanceof Error && 'code' in err ? String((err as { code: string }).code) : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts || !isRetryableError(code, msg)) throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
