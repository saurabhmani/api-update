import path from 'node:path';

/**
 * Canonical env file path for server bootstrap, PM2 workers, and CLI scripts.
 *
 * Resolution order:
 *   1. DOTENV_CONFIG_PATH — explicit override (PM2 ecosystem sets this)
 *   2. NODE_ENV=production → `.env.production`
 *   3. `.env.local` for development
 */
export function resolveEnvFilePath(cwd: string = process.cwd()): string {
  if (process.env.DOTENV_CONFIG_PATH) {
    return process.env.DOTENV_CONFIG_PATH;
  }
  if (process.env.NODE_ENV === 'production') {
    return path.resolve(cwd, '.env.production');
  }
  return path.resolve(cwd, '.env.local');
}
