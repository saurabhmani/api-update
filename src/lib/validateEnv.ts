// ════════════════════════════════════════════════════════════════
//  Environment Variable Validation
//
//  Called at app startup (instrumentation.ts or layout).
//  Throws descriptive error if required vars are missing.
// ════════════════════════════════════════════════════════════════

interface EnvRule {
  key: string;
  required: boolean;
  description: string;
}

const ENV_RULES: EnvRule[] = [
  { key: 'MYSQL_HOST',       required: true,  description: 'MySQL hostname' },
  { key: 'MYSQL_DATABASE',   required: true,  description: 'MySQL database name' },
  { key: 'MYSQL_USER',       required: true,  description: 'MySQL username' },
  { key: 'MYSQL_PASSWORD',   required: false, description: 'MySQL password' },
  { key: 'SESSION_SECRET',   required: true,  description: 'Secret for session signing (min 32 chars)' },
  { key: 'NEXT_PUBLIC_APP_URL', required: false, description: 'Public app URL (for CORS, redirects)' },
];

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Local `next start` / loopback testing — http://localhost is allowed even when NODE_ENV=production. */
function isLocalLoopbackAppBaseUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function isValidProductionAppBaseUrl(value: string): boolean {
  return isAbsoluteHttpsUrl(value) || isLocalLoopbackAppBaseUrl(value);
}

export function validateEnv(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = process.env.NODE_ENV === 'production';

  for (const rule of ENV_RULES) {
    const value = process.env[rule.key];
    if (rule.required && (!value || value.trim() === '')) {
      errors.push(`Missing required env var: ${rule.key} — ${rule.description}`);
    }
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret && sessionSecret.length < 32) {
    warnings.push(`SESSION_SECRET is short (${sessionSecret.length} chars). Recommend 32+ for production.`);
  }

  const provider = (process.env.MARKET_DATA_PROVIDER ?? '').trim().toLowerCase();
  const indianApiEnabledRaw = (process.env.INDIANAPI_ENABLED ?? '').trim().toLowerCase();
  const indianApiEnabled =
    indianApiEnabledRaw === 'true' || indianApiEnabledRaw === '1'
    || indianApiEnabledRaw === 'yes' || indianApiEnabledRaw === 'on';
  const indianApiKey = (
    process.env.INDIANAPI_API_KEY?.trim()
    || process.env.INDIANAPI_KEY?.trim()
    || process.env.INDIAN_API_KEY?.trim()
    || ''
  );

  // MARKET_DATA_PROVIDER=kite|zerodha is unsupported (resolves to none).
  if (provider === 'kite' || provider === 'zerodha' || provider === 'shoonya' || provider === 'finvasia') {
    warnings.push(
      `MARKET_DATA_PROVIDER=${provider} is unsupported for market data. `
      + 'Set MARKET_DATA_PROVIDER=indianapi and configure INDIANAPI_API_KEY.',
    );
  }

  // IndianAPI: explicit selection or bootstrap-default need a key.
  const wantsIndianApi =
    provider === 'indianapi'
    || (!provider && indianApiEnabled);

  if (wantsIndianApi || (isProd && !provider)) {
    if (!indianApiKey) {
      if (isProd && process.env.INDIANAPI_OPTIONAL !== 'true') {
        errors.push(
          'IndianAPI is the market-data upstream but INDIANAPI_API_KEY is not set. '
          + 'Set INDIANAPI_API_KEY (or INDIANAPI_KEY / INDIAN_API_KEY).',
        );
      } else if (!provider && indianApiEnabled) {
        warnings.push(
          'MARKET_DATA_PROVIDER is unset and INDIANAPI_ENABLED=true, but no INDIANAPI_API_KEY is set — '
          + 'system provider resolves to none. Set the key to activate the IndianAPI bootstrap default.',
        );
      } else {
        warnings.push(
          'IndianAPI credentials are not set — '
          + 'ingestion will refuse to run until INDIANAPI_API_KEY is configured.',
        );
      }
    }
    if (!indianApiEnabled && provider === 'indianapi') {
      warnings.push(
        'MARKET_DATA_PROVIDER selects IndianAPI but INDIANAPI_ENABLED is not true — '
        + 'ingestion jobs are feature-flag gated and will not run until INDIANAPI_ENABLED=true.',
      );
    }
  }

  const encKey = process.env.ENCRYPTION_KEY?.trim();
  if (!encKey || encKey.length < 64) {
    warnings.push(
      'ENCRYPTION_KEY not set or too short. TOTP secrets will use ' +
      'SHA-256(SESSION_SECRET) as fallback. For production, set a 64-char hex key: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  const brokerEnc = process.env.BROKER_TOKEN_ENCRYPTION_KEY?.trim();
  if (brokerEnc && !/^[0-9a-fA-F]{64}$/.test(brokerEnc)) {
    warnings.push(
      'BROKER_TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters if set '
      + '(legacy broker token encryption; not required for IndianAPI market data).',
    );
  } else if (!brokerEnc) {
    warnings.push(
      'BROKER_TOKEN_ENCRYPTION_KEY unset — obsolete for IndianAPI market data '
      + '(only needed for legacy broker_connections rows).',
    );
  }

  const obsoleteBrokerEnv = [
    'KITE_API_KEY',
    'KITE_API_SECRET',
    'KITE_REDIRECT_URL',
    'KITE_ACCESS_TOKEN',
    'KITE_ENABLED',
    'ZERODHA_API_KEY',
    'ZERODHA_API_SECRET',
    'SHOONYA_ENABLED',
    'SHOONYA_CLIENT_ID',
    'SHOONYA_SECRET_CODE',
    'SHOONYA_UID',
    'SHOONYA_PASSWORD',
    'SHOONYA_TOTP',
    'FINVASIA_API_KEY',
  ].filter((k) => Boolean(process.env[k]?.trim()));

  if (obsoleteBrokerEnv.length > 0) {
    warnings.push(
      `Obsolete broker env vars present (${obsoleteBrokerEnv.join(', ')}) — `
      + 'Kite/Zerodha/Shoonya are not used for market data. Remove them from deployment config.',
    );
  }

  const shoonyaEnabled = (process.env.SHOONYA_ENABLED ?? '').trim() === '1'
    || (process.env.SHOONYA_ENABLED ?? '').trim().toLowerCase() === 'true'
    || Boolean(process.env.SHOONYA_CLIENT_ID?.trim());

  if (shoonyaEnabled) {
    warnings.push(
      'SHOONYA_* is set but Shoonya is no longer used for market data (IndianAPI only).',
    );
  }

  const appBase =
    process.env.APP_BASE_URL?.trim()
    || process.env.APP_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || '';

  if (isProd) {
    if (!appBase) {
      errors.push('APP_BASE_URL (or APP_URL / NEXT_PUBLIC_APP_URL) is required in production.');
    } else if (!isValidProductionAppBaseUrl(appBase)) {
      errors.push(
        'APP_BASE_URL must be an absolute https:// URL in production '
        + '(http://localhost and http://127.0.0.1 are allowed for local next start).',
      );
    }

    if (process.env.SEED_ADMIN_PASSWORD) {
      warnings.push('SEED_ADMIN_PASSWORD is set in production — remove after initial setup.');
    }
    if (process.env.SEED_JOHN_PASSWORD || process.env.SEED_PRIYA_PASSWORD) {
      warnings.push('Test user seed passwords detected in production — remove from .env.local.');
    }
    if (!process.env.REDIS_HOST && process.env.REDIS_DISABLED !== 'true') {
      warnings.push('REDIS_HOST not set in production. Sessions will use DB-only (slower).');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Call at app init — logs warnings, throws on critical errors.
 */
export function ensureEnv(): void {
  const { valid, errors, warnings } = validateEnv();

  void warnings;
  if (!valid) {
    throw new Error(`Missing ${errors.length} required environment variable(s): ${errors.join('; ')}`);
  }
}
