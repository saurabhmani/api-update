import { config } from 'dotenv';
import { resolveEnvFilePath } from '../src/lib/envPath';

/** Load the project env file (`.env` on prod, `.env.local` in dev when present). */
export function loadProjectEnv(): string {
  const envPath = resolveEnvFilePath();
  config({ path: envPath });
  return envPath;
}
