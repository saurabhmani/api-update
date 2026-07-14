// ════════════════════════════════════════════════════════════════
//  Kite Connect — singleton HTTP client
//
//  Owns configuration, KiteConnect instantiation, access-token
//  updates, and a shared `call()` helper with typed error handling.
//
//  Does NOT wire into MarketDataProvider / marketDataResolver.
//  Phase 2 deliverable only — a reusable service layer.
// ════════════════════════════════════════════════════════════════

import { KiteConnect } from 'kiteconnect';
import type { Connect } from 'kiteconnect';
import { logger } from '@/lib/logger';
import {
  KiteConfigError,
  withKiteErrors,
} from './errors';
import type { KiteConfig } from './types';

const log = logger.child({ component: 'kite.client' });

const GLOBAL_KEY = '__q365_kite_connect_client__';

interface KiteClientGlobal {
  instance: KiteClient | null;
}

function glob(): KiteClientGlobal {
  const g = globalThis as unknown as Record<string, KiteClientGlobal | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { instance: null };
  return g[GLOBAL_KEY]!;
}

function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function loadKiteConfig(): KiteConfig {
  return {
    apiKey:       readEnv('KITE_API_KEY'),
    apiSecret:    readEnv('KITE_API_SECRET'),
    accessToken:  readEnv('KITE_ACCESS_TOKEN'),
    redirectUrl:  readEnv('KITE_REDIRECT_URL'),
  };
}

export function assertKiteConfig(cfg: KiteConfig = loadKiteConfig()): KiteConfig {
  if (!cfg.apiKey) {
    throw new KiteConfigError(
      'KITE_API_KEY is not set — add it to .env.local before using the Kite service layer',
    );
  }
  return cfg;
}

export class KiteClient {
  private readonly cfg: KiteConfig;
  private readonly kc: Connect;

  constructor(cfg?: Partial<KiteConfig>) {
    const loaded = loadKiteConfig();
    this.cfg = {
      apiKey:      cfg?.apiKey ?? loaded.apiKey,
      apiSecret:   cfg?.apiSecret ?? loaded.apiSecret,
      accessToken: cfg?.accessToken ?? loaded.accessToken,
      redirectUrl: cfg?.redirectUrl ?? loaded.redirectUrl,
    };
    assertKiteConfig(this.cfg);

    this.kc = new KiteConnect({
      api_key: this.cfg.apiKey,
      ...(this.cfg.accessToken ? { access_token: this.cfg.accessToken } : {}),
    });

    if (this.cfg.accessToken) {
      this.kc.setAccessToken(this.cfg.accessToken);
    }

    log.info('KiteConnect client initialized', {
      apiKeyPrefix: this.cfg.apiKey.slice(0, 4) + '…',
      hasAccessToken: Boolean(this.cfg.accessToken),
      hasRedirectUrl: Boolean(this.cfg.redirectUrl),
    });
  }

  /** Underlying SDK instance — prefer `call()` / module helpers. */
  get sdk(): Connect {
    return this.kc;
  }

  getConfig(): Readonly<KiteConfig> {
    return { ...this.cfg };
  }

  getLoginUrl(): string {
    return this.kc.getLoginURL();
  }

  setAccessToken(accessToken: string): void {
    const token = accessToken.trim();
    if (!token) {
      throw new KiteConfigError('setAccessToken requires a non-empty access token');
    }
    this.cfg.accessToken = token;
    this.kc.setAccessToken(token);
    log.info('Kite access token updated on singleton client');
  }

  getAccessToken(): string {
    return this.cfg.accessToken;
  }

  getApiSecret(): string {
    return this.cfg.apiSecret;
  }

  /**
   * Execute an SDK operation with centralized error normalization.
   * Example: `client.call((kc) => kc.getLTP(['NSE:RELIANCE']))`
   */
  async call<T>(fn: (kc: Connect) => Promise<T>): Promise<T> {
    if (!this.cfg.accessToken) {
      throw new KiteConfigError(
        'KITE_ACCESS_TOKEN is not set — call setAccessToken() or configure the env var',
      );
    }
    return withKiteErrors(() => fn(this.kc));
  }
}

/** Reset the singleton (tests / key rotation). */
export function resetKiteClient(): void {
  glob().instance = null;
}

/**
 * Process-wide singleton. Safe under Next.js HMR via `globalThis`.
 * Creates the client lazily on first import/use.
 */
export function getKiteClient(forceNew = false): KiteClient {
  const g = glob();
  if (forceNew || !g.instance) {
    g.instance = new KiteClient();
  }
  return g.instance;
}
