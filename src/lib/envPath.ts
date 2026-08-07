import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical env file path for server bootstrap, PM2 workers, and CLI scripts.
 *
 * Resolution order (must match server.js / ecosystem.config.js):
 *   1. DOTENV_CONFIG_PATH — explicit override
 *   2. NODE_ENV=production → `.env` if present, else `.env.production` (legacy fallback)
 *   3. `.env.local` when present (local / next-dev operator overrides)
 *   4. `.env`
 *
 * Production VPS uses `.env` (not `.env.production`). Prefer `.env` so
 * local workspace copies of `.env.production` cannot shadow live secrets.
 */
export function resolveEnvFilePath(cwd: string = process.cwd()): string {
  if (process.env.DOTENV_CONFIG_PATH) {
    return process.env.DOTENV_CONFIG_PATH;
  }
  if (process.env.NODE_ENV === 'production') {
    const flatEnv = path.resolve(cwd, '.env');
    if (fs.existsSync(flatEnv)) {
      return flatEnv;
    }
    const legacyProduction = path.resolve(cwd, '.env.production');
    if (fs.existsSync(legacyProduction)) {
      return legacyProduction;
    }
    return flatEnv;
  }
  const localPath = path.resolve(cwd, '.env.local');
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  return path.resolve(cwd, '.env');
}
