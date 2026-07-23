// Zerodha data-source adapter — reuses existing Kite OAuth routes

import { createBrokerAuthTransaction } from '../connections/authTransactions';
import {
  getBrokerConnectionByUserAndBroker,
  markBrokerConnectionStatus,
} from '../connections/repository';
import type { BrokerConnectionRecord } from '../connections/types';
import type { DataSourceBrokerAdapter, BrokerConnectionResult } from './types';

/**
 * Zerodha authorization is handled by the existing Kite Connect flow
 * (`/api/kite/auth/start` → callback → auth-complete). This adapter
 * exposes a stable data-source interface without duplicating token exchange.
 */
export const zerodhaBrokerAdapter: DataSourceBrokerAdapter = {
  name: 'zerodha',

  async getAuthorizationUrl(userId: number): Promise<string> {
    await createBrokerAuthTransaction({
      userId,
      broker: 'zerodha',
      state: null,
    });
    // Relative path — browser stays on the current host (avoid APP_BASE_URL mismatch).
    return '/api/kite/auth/start';
  },

  async handleCallback(): Promise<BrokerConnectionResult> {
    // Callback is owned by /api/kite/auth/callback — do not duplicate.
    return {
      ok: false,
      broker: 'zerodha',
      error: 'Use /api/kite/auth/callback for Zerodha OAuth',
      errorCode: 'use_kite_callback',
    };
  },

  async validateConnection(connection: BrokerConnectionRecord): Promise<boolean> {
    if (connection.broker !== 'zerodha') return false;
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
      'zerodha',
      'disconnected',
      true,
    );
  },
};

export async function getZerodhaConnection(userId: number) {
  return getBrokerConnectionByUserAndBroker(userId, 'zerodha');
}
