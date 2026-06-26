import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical env file path for server bootstrap, PM2 workers, and CLI scripts.
 *
 * Resolution order:
 *   1. DOTENV_CONFIG_PATH — explicit override (PM2 ecosystem sets this)
 *   2. NODE_ENV=production → `.env` (VPS / prod convention)
 *   3. `.env.local` when present (local dev operator overrides)
 *   4. `.env`
 */
export function resolveEnvFilePath(cwd: string = process.cwd()): string {
  if (process.env.DOTENV_CONFIG_PATH) {
    return process.env.DOTENV_CONFIG_PATH;
  }
  if (process.env.NODE_ENV === 'production') {
    return path.resolve(cwd, '.env');
  }
  const localPath = path.resolve(cwd, '.env.local');
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  return path.resolve(cwd, '.env');
}
