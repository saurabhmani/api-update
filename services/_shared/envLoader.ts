// ════════════════════════════════════════════════════════════════
//  Shared env loader — imported FIRST by every service's server.ts.
//
//  Hand-rolled to avoid a dotenv dep, identical to the pattern used
//  by src/lib/db/postgres/migrate.ts and friends. Keep this tiny and
//  side-effect-only: importing it loads the project env into process.env.
//  Production uses `.env.production`; development uses `.env.local`.
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import { resolveEnvFilePath } from '../../src/lib/envPath';

try {
  const envFile = fs.readFileSync(resolveEnvFilePath(), 'utf-8');
  for (const line of envFile.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch { /* env file optional */ }
