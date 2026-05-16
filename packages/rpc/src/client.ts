// ════════════════════════════════════════════════════════════════
//  RPC client — typed HTTP wrapper for service-to-service calls
//
//  Every gateway → service call and every service → service call
//  goes through here. Responsibilities:
//    • Resolve service URL from SERVICES registry + env var
//    • Attach correlation id to every request
//    • 2s timeout + 3-attempt retry with exponential backoff
//    • Return the typed ServiceResponse envelope
//    • Fail fast with a clear error message (no silent `{}`)
//
//  We deliberately do NOT pull in axios — Node's fetch is enough
//  and keeps packages/rpc dependency-free.
// ════════════════════════════════════════════════════════════════

import {
  CORRELATION_HEADER,
  newCorrelationId,
  SERVICES,
  type ServiceName,
  type ServiceResponse,
  type HealthResponse,
} from '@contracts/index';

export interface RpcOptions {
  correlationId?: string;
  timeoutMs?: number;
  attempts?: number;
  serviceAuthToken?: string;
  signal?: AbortSignal;
}

function resolveBaseUrl(service: ServiceName): string {
  const meta = SERVICES[service];
  const fromEnv = process.env[meta.envUrl];
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return `http://localhost:${meta.defaultPort}`;
}

function buildQuery(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.set(k, String(v));
  return `?${sp.toString()}`;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

async function requestOnce<TResp>(
  url: string,
  correlationId: string,
  opts: RpcOptions,
): Promise<ServiceResponse<TResp>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2000);
  const combined = opts.signal
    ? AbortSignal.any([ctrl.signal, opts.signal])
    : ctrl.signal;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        [CORRELATION_HEADER]: correlationId,
        Accept: 'application/json',
        ...(opts.serviceAuthToken ? { Authorization: `Bearer ${opts.serviceAuthToken}` } : {}),
      },
      signal: combined,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new RpcError(
        typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`,
        res.status,
        correlationId,
      );
    }
    if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).ok !== 'boolean') {
      throw new RpcError('Malformed service response (missing `ok` discriminator)', res.status, correlationId);
    }
    return body as ServiceResponse<TResp>;
  } finally {
    clearTimeout(timer);
  }
}

export async function rpcGet<TResp>(
  service: ServiceName,
  route: string,
  query: Record<string, unknown> = {},
  opts: RpcOptions = {},
): Promise<ServiceResponse<TResp>> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  const url = resolveBaseUrl(service) + route + buildQuery(query);
  const attempts = opts.attempts ?? 3;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await requestOnce<TResp>(url, correlationId, opts);
    } catch (err) {
      lastErr = err;
      // Don't retry 4xx — they won't get better on retry.
      if (err instanceof RpcError && err.status && err.status >= 400 && err.status < 500) {
        throw err;
      }
      if (i < attempts - 1) {
        const backoff = 100 * Math.pow(2, i);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  if (lastErr instanceof RpcError) throw lastErr;
  throw new RpcError(
    `rpc call failed after ${attempts} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    undefined,
    correlationId,
  );
}

// ── Typed service clients — thin wrappers so call sites stay ergonomic.

export const marketIngestion = {
  snapshot: (symbol: string, opts: RpcOptions = {}) =>
    rpcGet<import('@contracts/api').GetSnapshotResponse>(
      'marketIngestion',
      SERVICES.marketIngestion.routes.snapshot,
      { symbol },
      opts,
    ),
  historical: (symbol: string, range: string, opts: RpcOptions = {}) =>
    rpcGet<import('@contracts/api').GetHistoricalResponse>(
      'marketIngestion',
      SERVICES.marketIngestion.routes.historical,
      { symbol, range },
      opts,
    ),
  health: (opts: RpcOptions = {}) =>
    rpcGet<HealthResponse>(
      'marketIngestion',
      SERVICES.marketIngestion.routes.health,
      {},
      opts,
    ),
};
