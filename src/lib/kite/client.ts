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
import { recordKiteCall, markKiteSessionTokenPresent } from './health';

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

/**
 * App credentials from env. Access token is session-only (Redis / runtime
 * setAccessToken after OAuth) — never read from KITE_ACCESS_TOKEN.
 */
export function loadKiteConfig(): KiteConfig {
  return {
    apiKey:       readEnv('KITE_API_KEY'),
    apiSecret:    readEnv('KITE_API_SECRET'),
    accessToken:  '',
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
      markKiteSessionTokenPresent(true);
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
    markKiteSessionTokenPresent(true);
    log.info('Kite access token updated on singleton client');
  }

  getAccessToken(): string {
    return this.cfg.accessToken;
  }

  /**
   * Hydrate the PROCESS-GLOBAL Kite client from the SYSTEM feed session only.
   * Requires SYSTEM_MARKET_DATA_USER_ID. Never picks an arbitrary user's
   * broker_connections row. Interactive users must use the connection registry.
   */
  async hydrateAccessTokenFromSession(): Promise<boolean> {
    if (this.cfg.accessToken.trim()) return true;

    const { getSystemMarketDataUserId } = await import(
      '@/lib/marketData/connectionManager/systemFeed'
    );
    const { isValidSystemSessionOwner } = await import(
      '@/lib/marketData/jobs/jobClassification'
    );
    const systemUserId = getSystemMarketDataUserId();
    if (systemUserId == null) {
      log.warn('system_kite_hydrate_skipped', {
        reason: 'SYSTEM_MARKET_DATA_USER_ID unset — refusing cross-user token steal',
      });
      return false;
    }

    const { getSystemKiteSession } = await import('./active-session-store');
    const systemSession = await getSystemKiteSession();
    if (
      systemSession?.accessToken
      && isValidSystemSessionOwner(systemSession.quantorusUserId)
    ) {
      this.setAccessToken(systemSession.accessToken);
      return true;
    }
    if (systemSession?.accessToken) {
      log.warn('system_kite_hydrate_skipped', {
        reason: 'SYSTEM_SESSION_MISMATCH',
        sessionUserId: systemSession.quantorusUserId,
        systemUserId,
      });
    }

    try {
      const { getDecryptedAccessTokenForUser, getBrokerConnectionByUserAndBroker } = await import(
        '@/lib/broker/connections'
      );
      const row = await getBrokerConnectionByUserAndBroker(systemUserId, 'zerodha');
      if (!row || row.status !== 'active') return false;

      const decrypted = await getDecryptedAccessTokenForUser(systemUserId, 'zerodha');
      if (!decrypted) return false;

      this.setAccessToken(decrypted);
      const { saveUserKiteSession } = await import('./active-session-store');
      await saveUserKiteSession(systemUserId, {
        accessToken: decrypted,
        kiteUserId: String(row.brokerAccountId ?? 'unknown').trim() || 'unknown',
        quantorusUserId: String(systemUserId),
        authenticatedAt: row.lastAuthenticatedAt
          ? new Date(row.lastAuthenticatedAt).toISOString()
          : new Date().toISOString(),
      }).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  getApiSecret(): string {
    return this.cfg.apiSecret;
  }

  /**
   * Execute an SDK operation with centralized error normalization.
   * Example: `client.call((kc) => kc.getLTP(['NSE:RELIANCE']))`
   * Phase 8: every hop updates the Kite health tracker.
   */
  async call<T>(fn: (kc: Connect) => Promise<T>): Promise<T> {
    const hydrated = await this.hydrateAccessTokenFromSession();
    if (!hydrated || !this.cfg.accessToken) {
      const err = new KiteConfigError(
        'No active Kite session — connect Zerodha from the dashboard',
      );
      recordKiteCall({ operation: 'call', success: false, error: err, latencyMs: 0 });
      throw err;
    }
    const t0 = Date.now();
    try {
      const out = await withKiteErrors(() => fn(this.kc));
      recordKiteCall({
        operation: 'call',
        success: true,
        latencyMs: Date.now() - t0,
      });
      return out;
    } catch (err) {
      recordKiteCall({
        operation: 'call',
        success: false,
        latencyMs: Date.now() - t0,
        error: err,
      });
      throw err;
    }
  }
}

/** Reset the singleton (tests / key rotation). */
export function resetKiteClient(): void {
  glob().instance = null;
  markKiteSessionTokenPresent(false);
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
