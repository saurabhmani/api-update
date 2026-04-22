// ════════════════════════════════════════════════════════════════
//  kiteRest — NEUTRALIZED STUB
//
//  All REST calls throw. Signal-only mode places no orders and
//  fetches no Kite REST data; any code path that still reaches
//  here is a leftover and should be migrated off.
// ════════════════════════════════════════════════════════════════

export class KiteAuthError extends Error {
  constructor(msg = 'kite_removed') {
    super(msg);
    this.name = 'KiteAuthError';
  }
}

export class KiteApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`KITE_API_ERROR status=${status} body=${body.slice(0, 120)}`);
    this.name = 'KiteApiError';
  }
}

export interface KiteClientOptions {
  appUserId?: number;
}

export interface KiteClient {
  setAccessToken(token: string): void;
  clearAccessToken(): void;
  get<T = any>(path: string, query?: Record<string, any>): Promise<T>;
  post<T = any>(path: string, body?: Record<string, any>): Promise<T>;
  del<T = any>(path: string, query?: Record<string, any>): Promise<T>;
}

function removed<T>(_path: string): Promise<T> {
  return Promise.reject(new KiteAuthError('kite_removed'));
}

export function createKiteClient(_opts: KiteClientOptions = {}): KiteClient {
  return {
    setAccessToken: () => { /* no-op */ },
    clearAccessToken: () => { /* no-op */ },
    get:  <T>(path: string) => removed<T>(path),
    post: <T>(path: string) => removed<T>(path),
    del:  <T>(path: string) => removed<T>(path),
  };
}

export const kite: KiteClient = createKiteClient();
