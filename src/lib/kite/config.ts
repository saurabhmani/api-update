// ════════════════════════════════════════════════════════════════
//  Kite Connect — Phase 1 configuration loader (server-only)
//
//  Reads Zerodha app credentials from process.env.
//  Never import this module from client components or shared barrels.
// ════════════════════════════════════════════════════════════════

import 'server-only';

import { KiteConfigError } from './errors';

export interface KitePhase1Config {
  apiKey: string;
  apiSecret: string;
  /** Present when KITE_REDIRECT_URL is set; otherwise undefined. */
  redirectUrl?: string;
}

function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * Load and validate Phase 1 Zerodha Kite credentials.
 *
 * Required:
 *   - KITE_API_KEY
 *   - KITE_API_SECRET
 *
 * Optional:
 *   - KITE_REDIRECT_URL
 *
 * Does not read or return KITE_ACCESS_TOKEN.
 * Does not log secret values.
 *
 * @throws {KiteConfigError} when a required env var is missing or empty
 */
export function getKiteConfig(): KitePhase1Config {
  const apiKey = readEnv('KITE_API_KEY');
  const apiSecret = readEnv('KITE_API_SECRET');
  const redirectUrl = readEnv('KITE_REDIRECT_URL');

  if (!apiKey) {
    throw new KiteConfigError(
      'KITE_API_KEY is not set — add it to .env.local (or the process environment) before using the Kite service layer',
    );
  }

  if (!apiSecret) {
    throw new KiteConfigError(
      'KITE_API_SECRET is not set — add it to .env.local (or the process environment) before using the Kite service layer',
    );
  }

  const config: KitePhase1Config = {
    apiKey,
    apiSecret,
  };

  if (redirectUrl) {
    config.redirectUrl = redirectUrl;
  }

  return config;
}
