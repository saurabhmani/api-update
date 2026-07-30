// Zerodha data-source adapter — reuses existing Kite OAuth routes

import { createBrokerAuthTransaction } from '../connections/authTransactions';
import {
  getBrokerConnectionByUserAndBroker,
} from '../connections/repository';
import { setCredentialStatus, isCredentialUsable } from '../connections/credentialStatus';
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
    return isCredentialUsable(connection);
  },

  async disconnect(connection: BrokerConnectionRecord): Promise<void> {
    await setCredentialStatus({
      userId: connection.userId,
      broker: 'zerodha',
      newStatus: 'disconnected',
      reason: 'manual_disconnect',
      source: 'zerodhaAdapter.disconnect',
      clearTokens: true,
    });
  },
};

export async function getZerodhaConnection(userId: number) {
  return getBrokerConnectionByUserAndBroker(userId, 'zerodha');
}
