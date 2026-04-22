// ════════════════════════════════════════════════════════════════
//  Shared env loader — imported FIRST by every service's server.ts.
//
//  Hand-rolled to avoid a dotenv dep, identical to the pattern used
//  by src/lib/db/postgres/migrate.ts and friends. Keep this tiny and
//  side-effect-only: importing it loads .env.local into process.env.
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
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
} catch { /* .env.local optional */ }
