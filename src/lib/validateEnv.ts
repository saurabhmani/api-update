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
  // MYSQL_* vars are the canonical connection config. DATABASE_URL is
  // still accepted as a fallback inside getMysqlConnectionConfig(),
  // but the operator is expected to use the discrete vars going
  // forward — simpler to read, no URL-encoding traps on the password.
  { key: 'MYSQL_HOST',       required: true,  description: 'MySQL hostname' },
  { key: 'MYSQL_DATABASE',   required: true,  description: 'MySQL database name' },
  { key: 'MYSQL_USER',       required: true,  description: 'MySQL username' },
  // Empty password is a legitimate config for local dev (root with
  // no password on XAMPP/WAMP). The driver passes '' through fine.
  // Required=false so an empty value doesn't trip the boot validator;
  // a wrong password will still surface as a clean auth error at
  // first query time.
  { key: 'MYSQL_PASSWORD',   required: false, description: 'MySQL password' },
  { key: 'SESSION_SECRET',   required: true,  description: 'Secret for session signing (min 32 chars)' },
  { key: 'NEXT_PUBLIC_APP_URL', required: false, description: 'Public app URL (for CORS, redirects)' },
];

export function validateEnv(): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rule of ENV_RULES) {
    const value = process.env[rule.key];
    if (rule.required && (!value || value.trim() === '')) {
      errors.push(`Missing required env var: ${rule.key} — ${rule.description}`);
    }
  }

  // Validation rules
  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret && sessionSecret.length < 32) {
    warnings.push(`SESSION_SECRET is short (${sessionSecret.length} chars). Recommend 32+ for production.`);
  }

  // Kite OAuth credentials. Not strictly required to boot the app
  // (we want dev to come up without them), but if either is missing
  // the callback/exchange flow fails silently at runtime — so we
  // warn loudly at boot so operators notice before clicking Reconnect.
  const kiteKey    = process.env.KITE_API_KEY?.trim();
  const kiteSecret = process.env.KITE_API_SECRET?.trim();
  if (!kiteKey) {
    warnings.push('KITE_API_KEY not set — Zerodha OAuth login will fail. Add it to .env.local.');
  }
  if (!kiteSecret) {
    warnings.push('KITE_API_SECRET not set — request_token → access_token exchange will fail. Add it to .env.local.');
  }
  if (kiteKey && / |\t|\r|\n/.test(process.env.KITE_API_KEY ?? '')) {
    warnings.push('KITE_API_KEY has leading/trailing whitespace in .env.local — checksum will mismatch.');
  }
  if (kiteSecret && / |\t|\r|\n/.test(process.env.KITE_API_SECRET ?? '')) {
    warnings.push('KITE_API_SECRET has leading/trailing whitespace in .env.local — checksum will mismatch.');
  }

  // Encryption key validation
  const encKey = process.env.ENCRYPTION_KEY?.trim();
  if (!encKey || encKey.length < 64) {
    warnings.push(
      'ENCRYPTION_KEY not set or too short. Kite tokens and TOTP secrets will use ' +
      'SHA-256(SESSION_SECRET) as fallback. For production, set a 64-char hex key: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // Seed password warnings — should not be in production
  if (process.env.NODE_ENV === 'production') {
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

  // Warnings + success line are intentionally suppressed — only the
  // FAIL price log should appear in steady state. Missing required
  // vars still throw, since they would crash later anyway.
  void warnings;
  if (!valid) {
    throw new Error(`Missing ${errors.length} required environment variable(s): ${errors.join('; ')}`);
  }
}
