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

  // Kite removed — signal-only mode. KITE_* env vars are no longer
  // consulted; leaving them in .env.local is harmless.

  // Encryption key validation
  const encKey = process.env.ENCRYPTION_KEY?.trim();
  if (!encKey || encKey.length < 64) {
    warnings.push(
      'ENCRYPTION_KEY not set or too short. TOTP secrets will use ' +
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
