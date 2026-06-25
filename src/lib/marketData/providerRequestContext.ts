import { AsyncLocalStorage } from 'async_hooks';

export interface ProviderRequestContext {
  jobId?: string;
  sourceJob?: string;
  requestType?: string;
  symbol?: string;
}

const storage = new AsyncLocalStorage<ProviderRequestContext>();

export function getProviderRequestContext(): ProviderRequestContext | undefined {
  return storage.getStore();
}

export function runWithProviderRequestContext<T>(
  ctx: ProviderRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function mergeProviderRequestContext(
  patch: ProviderRequestContext,
): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}
