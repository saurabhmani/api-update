// ════════════════════════════════════════════════════════════════
//  Test bootstrap — loads .env.local into process.env
//
//  Test files outside Next.js need DATABASE_URL etc. injected.
//  Import this FIRST in any test that hits the DB:
//
//      import './loadEnv';
// ════════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';

function loadEnvFile(filename: string): void {
  const envPath = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// Load .env.local first (Next.js convention), then .env as fallback
loadEnvFile('.env.local');
loadEnvFile('.env');
