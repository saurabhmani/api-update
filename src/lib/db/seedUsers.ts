/**
 * Quantorus365 — Seed Users
 * Adds users to the database.
 * Run: npm run db:seed-users
 * Safe to re-run — skips users that already exist.
 */
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

// Load .env.local
try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

// ── Define your users here ────────────────────────────────────────
// Passwords are read from .env.local — never hardcode credentials.
// Required env vars: SEED_ADMIN_PASSWORD, SEED_JOHN_PASSWORD, SEED_PRIYA_PASSWORD
function requirePwd(envKey: string): string {
  const v = process.env[envKey];
  if (!v || v.length < 8) {
    throw new Error(`${envKey} not set in .env.local (or shorter than 8 chars)`);
  }
  return v;
}

const USERS = [
  { email: 'admin@quantorus365.in', name: 'Admin',      password: requirePwd('SEED_ADMIN_PASSWORD'), role: 'admin' },
  { email: 'john@quantorus365.in',  name: 'John Doe',   password: requirePwd('SEED_JOHN_PASSWORD'),  role: 'user'  },
  { email: 'priya@quantorus365.in', name: 'Priya Shah', password: requirePwd('SEED_PRIYA_PASSWORD'), role: 'user'  },
];
// ─────────────────────────────────────────────────────────────────


async function seedUsers() {
  const { getMysqlConnectionConfig } = await import('../db');
  const cfg = getMysqlConnectionConfig();
  const conn = await mysql.createConnection(cfg);

  console.log('Seeding users...\n');

  for (const u of USERS) {
    const [existing] = await conn.execute<any[]>(
      `SELECT id FROM users WHERE email = ?`, [u.email]
    );
    if ((existing as any[]).length > 0) {
      console.log(`⏭  Skipped  ${u.email} (already exists)`);
      continue;
    }
    const hash = await bcrypt.hash(u.password, 12);
    await conn.execute(
      `INSERT INTO users (email, name, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)`,
      [u.email, u.name, hash, u.role]
    );
    console.log(`✓  Created  ${u.email}  [${u.role}]`);
  }

  console.log('\n✅ Done.');
  await conn.end();
}

seedUsers().catch(err => { console.error(err); process.exit(1); });
