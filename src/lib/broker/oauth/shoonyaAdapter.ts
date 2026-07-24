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

    if (!tx) {
      // Idempotent duplicate: recent successful completion + active connection.
      const recent = await findRecentCompletedAuthTransaction({
        userId,
        broker: 'shoonya',
      });
      const existing = await getBrokerConnectionByUserAndBroker(userId, 'shoonya');
      if (recent && existing?.status === 'active' && existing.accessTokenEncrypted) {
        return { ok: true, broker: 'shoonya', connection: existing };
      }

      return {
        ok: false,
        broker: 'shoonya',
        error: 'Invalid or expired authentication session',
        errorCode: 'invalid_transaction',
      };
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

      const connection = await upsertBrokerConnectionRecord({
        userId,
        broker: 'shoonya',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        brokerAccountId: tokens.accountId ?? null,
        brokerUserName: tokens.userName ?? null,
        tokenExpiresAt: expiresAt,
        status: 'active',
        isPrimary: true,
        metadata: {
          source: 'shoonya_oauth',
          responseKeys: tokens.rawKeys,
          // Sanitized diagnosis only — never store tokens/secrets here.
          rawExpiresIn: tokens.rawExpiresIn ?? null,
          expiryParsed: Boolean(parsedExpiry),
          expiryFallbackApplied: !parsedExpiry,
        },
      });

      // Completed only after persistence succeeds.
      await completeBrokerAuthTransaction(tx.id);

      return { ok: true, broker: 'shoonya', connection };
    } catch (err) {
      await failBrokerAuthTransaction(tx.id).catch(() => {});

      if (err instanceof ShoonyaConfigError) {
        return {
          ok: false,
          broker: 'shoonya',
          error: 'Shoonya is not configured',
          errorCode: 'not_configured',
        };
      }
      if (err instanceof ShoonyaExchangeError) {
        return {
          ok: false,
          broker: 'shoonya',
          error: 'Authentication failed',
          errorCode: 'authentication_failed',
        };
      }
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
