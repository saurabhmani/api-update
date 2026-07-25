import {
  completeBrokerAuthTransaction,
  consumeBrokerAuthTransaction,
  createBrokerAuthTransaction,
  failBrokerAuthTransaction,
  findRecentCompletedAuthTransaction,
} from '../connections/authTransactions';
import {
  getBrokerConnectionByUserAndBroker,
  markBrokerConnectionStatus,
  upsertBrokerConnectionRecord,
} from '../connections/repository';
import { resolvePrimaryFlagOnConnect } from '../connections/activeDataSource';
import { parseBrokerTokenExpiry } from '../connections/expiry';
import type { BrokerConnectionRecord } from '../connections/types';
import {
  buildShoonyaAuthorizeUrl,
  exchangeShoonyaAuthorizationCode,
  getShoonyaConfig,
  ShoonyaConfigError,
  ShoonyaExchangeError,
} from './shoonya';
import type { BrokerConnectionResult, DataSourceBrokerAdapter } from './types';

export const shoonyaBrokerAdapter: DataSourceBrokerAdapter = {
  name: 'shoonya',

  async getAuthorizationUrl(userId: number): Promise<string> {
    const config = getShoonyaConfig();
    // Shoonya authorize URL may not echo state; bind pending tx to session user.
    await createBrokerAuthTransaction({
      userId,
      broker: 'shoonya',
      state: null,
    });
    return buildShoonyaAuthorizeUrl(config.clientId, config.authorizeUrl);
  },

  async handleCallback(
    userId: number,
    params: Record<string, string | null>,
  ): Promise<BrokerConnectionResult> {
    // Live callback uses ?code=… (confirmed by Shoonya OAuth docs / SDKs).
    const code = (params.code ?? params.auth_code ?? params.AuthCode)?.trim() ?? '';
    if (!code) {
      return {
        ok: false,
        broker: 'shoonya',
        error: 'Missing authorization code',
        errorCode: 'missing_code',
      };
    }

    const tx = await consumeBrokerAuthTransaction({
      userId,
      broker: 'shoonya',
      // Authorize URL does not send state; Shoonya may still echo one. Pending
      // rows are bound to the signed-in user only (state_hash NULL).
      state: null,
    });

    // Session cookie already binds the callback to this user. A missing/expired
    // pending row used to hard-fail as invalid_transaction (common after
    // https://localhost HSTS retries or slow OAuth). Still exchange the code.
    if (!tx) {
      console.warn('[shoonya/callback] no pending auth transaction; continuing with session bind', {
        userId,
      });
    }

    try {
      const tokens = await exchangeShoonyaAuthorizationCode(code);
      const parsedExpiry = tokens.expiresAt
        ? parseBrokerTokenExpiry(tokens.expiresAt)
        : null;
      // Always persist an expiry. Prefer broker-reported value; otherwise a
      // conservative 24h fallback so consumers can detect stale sessions.
      const SHOONYA_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
      const expiresAt = parsedExpiry ?? new Date(Date.now() + SHOONYA_TOKEN_TTL_MS);

      // Phase 12: first broker → active; never steal another active source.
      const isPrimary = await resolvePrimaryFlagOnConnect(userId, 'shoonya');

      const connection = await upsertBrokerConnectionRecord({
        userId,
        broker: 'shoonya',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        brokerAccountId: tokens.accountId ?? null,
        brokerUserName: tokens.userName ?? null,
        tokenExpiresAt: expiresAt,
        status: 'active',
        isPrimary,
        metadata: {
          source: 'shoonya_oauth',
          responseKeys: tokens.rawKeys,
          // Sanitized diagnosis only — never store tokens/secrets here.
          rawExpiresIn: tokens.rawExpiresIn ?? null,
          expiryParsed: Boolean(parsedExpiry),
          expiryFallbackApplied: !parsedExpiry,
          activatedOnConnect: isPrimary,
        },
      });

      // Completed only after persistence succeeds.
      if (tx) {
        await completeBrokerAuthTransaction(tx.id);
      }

      return { ok: true, broker: 'shoonya', connection };
    } catch (err) {
      if (tx) {
        await failBrokerAuthTransaction(tx.id).catch(() => {});
      }

      // Idempotent duplicate after a lost first response: code may already be
      // spent but connection was saved.
      const existing = await getBrokerConnectionByUserAndBroker(userId, 'shoonya');
      if (existing?.status === 'active' && existing.accessTokenEncrypted) {
        const recent = await findRecentCompletedAuthTransaction({
          userId,
          broker: 'shoonya',
        });
        if (recent || !tx) {
          return { ok: true, broker: 'shoonya', connection: existing };
        }
      }
      if (err instanceof ShoonyaConfigError) {
        return {
          ok: false,
          broker: 'shoonya',
          error: 'Shoonya is not configured',
          errorCode: 'not_configured',
        };
      }
      if (err instanceof ShoonyaExchangeError) {
        console.error('[shoonya/callback] token exchange failed', {
          status: err.status,
          brokerMessage: err.brokerMessage,
        });
        const msg = (err.brokerMessage ?? '').toLowerCase();
        if (msg.includes('invalid_verifier') || msg.includes('invalid verifier')) {
          return {
            ok: false,
            broker: 'shoonya',
            error: 'Invalid verifier',
            errorCode: 'shoonya_invalid_verifier',
          };
        }
        if (msg.includes('whitelist') || msg.includes('ip')) {
          return {
            ok: false,
            broker: 'shoonya',
            error: 'IP not whitelisted',
            errorCode: 'shoonya_ip_whitelist',
          };
        }
        return {
          ok: false,
          broker: 'shoonya',
          error: 'Authentication failed',
          errorCode: 'shoonya_token_exchange',
        };
      }
      console.error('[shoonya/callback] unexpected failure', {
        reason: err instanceof Error ? err.name : 'unknown',
      });
      return {
        ok: false,
        broker: 'shoonya',
        error: 'Authentication failed',
        errorCode: 'authentication_failed',
      };
    }
  },

  async validateConnection(connection: BrokerConnectionRecord): Promise<boolean> {
    if (connection.broker !== 'shoonya') return false;
    if (connection.status !== 'active') return false;
    if (!connection.accessTokenEncrypted) return false;
    if (connection.tokenExpiresAt) {
      const t = new Date(connection.tokenExpiresAt).getTime();
      if (!Number.isNaN(t) && t <= Date.now()) return false;
    }
    return true;
  },

  async disconnect(connection: BrokerConnectionRecord): Promise<void> {
    await markBrokerConnectionStatus(
      connection.userId,
      'shoonya',
      'disconnected',
      true,
    );
  },
};

export async function getShoonyaConnection(userId: number) {
  return getBrokerConnectionByUserAndBroker(userId, 'shoonya');
}
