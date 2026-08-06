import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical env file path for server bootstrap, PM2 workers, and CLI scripts.
 *
 * Resolution order (must match server.js):
 *   1. DOTENV_CONFIG_PATH — explicit override (PM2 ecosystem sets this)
 *   2. NODE_ENV=production → `.env.production` if present, else `.env`
 *   3. `.env.local` when present (local dev operator overrides)
 *   4. `.env`
 *
 * Scan CLIs and the scheduler must use this helper so they never
 * accidentally load `.env.local` on a production host (or vice versa).
 */
export function resolveEnvFilePath(cwd: string = process.cwd()): string {
  if (process.env.DOTENV_CONFIG_PATH) {
    return process.env.DOTENV_CONFIG_PATH;
  }
  if (process.env.NODE_ENV === 'production') {
    const productionPath = path.resolve(cwd, '.env.production');
    if (fs.existsSync(productionPath)) {
      return productionPath;
    }
    return path.resolve(cwd, '.env');
  }
  const localPath = path.resolve(cwd, '.env.local');
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  return path.resolve(cwd, '.env');
}
