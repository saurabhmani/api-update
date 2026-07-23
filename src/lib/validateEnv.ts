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
  const kitePrimary = !provider || provider === 'kite';
  if (kitePrimary) {
    const key = (process.env.KITE_API_KEY ?? '').trim();
    if (!key) {
      warnings.push(
        'MARKET_DATA_PROVIDER defaults to kite but KITE_API_KEY looks unset — '
        + 'expect yahoo/nse/db cascade until Kite app credentials and a dashboard session exist.',
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
    errors.push(
      'BROKER_TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).',
    );
  } else if (!brokerEnc) {
    if (isProd && process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY !== '1') {
      errors.push(
        'BROKER_TOKEN_ENCRYPTION_KEY is required in production (64 hex chars).',
      );
    } else {
      warnings.push(
        'BROKER_TOKEN_ENCRYPTION_KEY unset — broker tokens will fall back to ENCRYPTION_KEY / SESSION_SECRET.',
      );
    }
  }

  const shoonyaEnabled = (process.env.SHOONYA_ENABLED ?? '').trim() === '1'
    || (process.env.SHOONYA_ENABLED ?? '').trim().toLowerCase() === 'true'
    || Boolean(process.env.SHOONYA_CLIENT_ID?.trim());

  if (shoonyaEnabled) {
    if (!process.env.SHOONYA_CLIENT_ID?.trim()) {
      errors.push('SHOONYA_CLIENT_ID is required when Shoonya is enabled.');
    }
    if (!process.env.SHOONYA_SECRET_CODE?.trim()) {
      errors.push('SHOONYA_SECRET_CODE is required when Shoonya is enabled.');
    }
  } else if (!process.env.SHOONYA_CLIENT_ID?.trim() || !process.env.SHOONYA_SECRET_CODE?.trim()) {
    warnings.push(
      'SHOONYA_CLIENT_ID / SHOONYA_SECRET_CODE unset — Shoonya data-source login will be unavailable.',
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
    } else if (!isAbsoluteHttpsUrl(appBase)) {
      errors.push('APP_BASE_URL must be an absolute https:// URL in production.');
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
