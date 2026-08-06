/**
 * Safe runtime identity for diagnostics. Never logs passwords, keys,
 * or full connection strings.
 */
export type ProcessRole =
  | 'web'
  | 'scheduler'
  | 'scan-cli'
  | 'diagnostics'
  | 'worker'
  | 'unknown';

export interface RuntimeIdentity {
  component: string;
  processRole: ProcessRole;
  databaseHost: string;
  databaseName: string;
  databasePort: number;
  redisHost: string;
  redisPort: number;
  redisDisabled: boolean;
  nodeEnv: string;
  timezone: string;
  processTz: string | null;
  envFileHint: string | null;
  indianApiEnabled: boolean;
}

function firstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function parseDatabaseUrlHostDb(url: string | undefined): { host: string; database: string; port: number } | null {
  if (!url || !url.trim()) return null;
  try {
    // Avoid logging the full URL; only parse host/db/port.
    const u = new URL(url.replace(/^mysql:\/\//i, 'http://').replace(/^mysql2:\/\//i, 'http://'));
    return {
      host: u.hostname || 'unknown',
      database: (u.pathname || '').replace(/^\//, '') || 'unknown',
      port: Number(u.port || 3306) || 3306,
    };
  } catch {
    return null;
  }
}

export function resolveRuntimeIdentity(opts: {
  component: string;
  processRole?: ProcessRole;
  envFileHint?: string | null;
} = { component: 'app' }): RuntimeIdentity {
  const fromUrl = parseDatabaseUrlHostDb(process.env.DATABASE_URL);
  const databaseHost = firstNonEmpty(process.env.MYSQL_HOST, fromUrl?.host, 'unknown') || 'unknown';
  const databaseName = firstNonEmpty(process.env.MYSQL_DATABASE, fromUrl?.database, 'unknown') || 'unknown';
  const databasePort = Number(process.env.MYSQL_PORT || fromUrl?.port || 3306) || 3306;
  const redisHost = firstNonEmpty(process.env.REDIS_HOST, '127.0.0.1') || '127.0.0.1';
  const redisPort = Number(process.env.REDIS_PORT || 6379) || 6379;
  const redisDisabled = ['1', 'true', 'yes'].includes(
    String(process.env.REDIS_DISABLED || '').toLowerCase(),
  );
  const indianApiKey = firstNonEmpty(process.env.INDIANAPI_API_KEY, process.env.INDIAN_API_KEY);
  const indianApiEnabled = Boolean(indianApiKey) &&
    !['0', 'false', 'off'].includes(String(process.env.INDIANAPI_ENABLED || '1').toLowerCase());

  return {
    component: opts.component,
    processRole: opts.processRole ?? 'unknown',
    databaseHost,
    databaseName,
    databasePort,
    redisHost,
    redisPort,
    redisDisabled,
    nodeEnv: process.env.NODE_ENV || 'undefined',
    timezone: 'Asia/Kolkata',
    processTz: process.env.TZ || null,
    envFileHint: opts.envFileHint ?? process.env.DOTENV_CONFIG_PATH ?? null,
    indianApiEnabled,
  };
}

export function logRuntimeIdentity(opts: {
  component: string;
  processRole?: ProcessRole;
  envFileHint?: string | null;
}): RuntimeIdentity {
  const id = resolveRuntimeIdentity(opts);
  console.log(
    `[RUNTIME_IDENTITY] component=${id.component} processRole=${id.processRole} ` +
    `databaseHost=${id.databaseHost} databaseName=${id.databaseName} ` +
    `databasePort=${id.databasePort} redisHost=${id.redisHost} ` +
    `redisDisabled=${id.redisDisabled ? 1 : 0} nodeEnv=${id.nodeEnv} ` +
    `timezone=${id.timezone} processTz=${id.processTz ?? 'unset'} ` +
    `indianApiEnabled=${id.indianApiEnabled ? 1 : 0} ` +
    `envFileHint=${id.envFileHint ?? 'default'}`,
  );
  return id;
}
