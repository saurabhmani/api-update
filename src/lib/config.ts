// ════════════════════════════════════════════════════════════════
//  App Config — Typed, validated infrastructure configuration
//
//  Reads from process.env once at import time. All infra settings
//  live here. Business thresholds stay in systemConfigService.
//
//  Usage:
//    import { config } from '@/lib/config';
//    config.db.host   // string
//    config.redis.port // number
//    config.app.env   // 'development' | 'production' | 'test'
// ════════════════════════════════════════════════════════════════

export interface AppConfig {
  app: {
    env: 'development' | 'production' | 'test';
    name: string;
    version: string;
    url: string;
    logLevel: string;
  };
  db: {
    // Connection URL kept for backward compat; synthesized from the
    // MYSQL_* fields when DATABASE_URL isn't set in the environment.
    url: string;
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
  };
  redis: {
    enabled: boolean;
    host: string;
    port: number;
    password: string | undefined;
  };
  session: {
    secret: string;
  };
}

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined && val.trim() !== '') return val.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Env var ${key} must be an integer, got: ${raw}`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1';
}

function loadConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppConfig['app']['env'];

  return {
    app: {
      env: nodeEnv,
      name: 'quantorus365',
      version: process.env.npm_package_version ?? '2.1.0',
      url: env('NEXT_PUBLIC_APP_URL', 'http://localhost:3000'),
      logLevel: env('LOG_LEVEL', 'info'),
    },
    db: (() => {
      const host = env('MYSQL_HOST');
      const port = envInt('MYSQL_PORT', 3306);
      const user = env('MYSQL_USER');
      const password = env('MYSQL_PASSWORD');
      const database = env('MYSQL_DATABASE');
      // Prefer an explicit DATABASE_URL when set (legacy), otherwise
      // synthesize one from the discrete vars so consumers that still
      // read config.db.url keep working after DATABASE_URL is retired.
      const explicit = process.env.DATABASE_URL?.trim();
      const url = explicit && explicit.length > 0
        ? explicit
        : `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
      return {
        url, host, port, user, password, database,
        connectionLimit: envInt('DB_CONNECTION_LIMIT', 10),
      };
    })(),
    redis: {
      enabled: process.env.REDIS_DISABLED !== '1' && process.env.REDIS_DISABLED !== 'true',
      host: env('REDIS_HOST', '127.0.0.1'),
      port: envInt('REDIS_PORT', 6379),
      password: process.env.REDIS_PASSWORD?.trim() || undefined,
    },
    session: {
      secret: env('SESSION_SECRET'),
    },
  };
}

// Lazy singleton — avoids crashing at import time if env isn't loaded yet
let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/** Direct access for convenience. Throws if env is missing. */
export const config: AppConfig = new Proxy({} as AppConfig, {
  get(_target, prop: string) {
    return getConfig()[prop as keyof AppConfig];
  },
});
