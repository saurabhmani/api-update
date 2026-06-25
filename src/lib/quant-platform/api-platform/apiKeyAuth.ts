// Public API Platform — API key authentication

import { createHash, randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { RATE_LIMITS, checkRateLimit } from '@/lib/security/rateLimiter';
import type { NextRequest } from 'next/server';
import { ensureQuantTables } from '../repository/quantRepository';

export interface ApiKeyContext {
  clientId: number;
  userId: number;
  plan: string;
  scopes: string[];
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export async function createApiKey(userId: number, name: string, scopes: string[] = ['read']): Promise<{
  rawKey: string;
  prefix: string;
  clientId: number;
}> {
  await ensureQuantTables();
  const clientRes = await db.query(
    `INSERT INTO api_clients (name, user_id, plan) VALUES (?, ?, 'pro')`,
    [name, userId],
  );
  const clientId = Number(clientRes.insertId);
  const rawKey = `q365_${randomBytes(24).toString('hex')}`;
  const prefix = rawKey.slice(0, 12);
  await db.query(
    `INSERT INTO api_keys (client_id, key_hash, key_prefix, scopes_json) VALUES (?, ?, ?, ?)`,
    [clientId, hashKey(rawKey), prefix, JSON.stringify(scopes)],
  );
  return { rawKey, prefix, clientId };
}

export async function validateApiKey(req: NextRequest): Promise<ApiKeyContext | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const rawKey = auth.slice(7).trim();
  if (!rawKey.startsWith('q365_')) return null;

  await ensureQuantTables();
  const { rows } = await db.query(
    `SELECT k.id, k.client_id, k.scopes_json, c.user_id, c.plan, c.active
       FROM api_keys k
       JOIN api_clients c ON c.id = k.client_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL AND c.active = 1`,
    [hashKey(rawKey)],
  );
  const row = rows[0] as any;
  if (!row) return null;

  await db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = ?`, [row.id]);

  const rate = await checkRateLimit(req, {
    ...RATE_LIMITS.api,
    keyPrefix: `apikey:${row.client_id}`,
    max: row.plan === 'enterprise' ? 300 : 60,
  });
  if (!rate.ok) return null;

  const scopes = typeof row.scopes_json === 'string'
    ? JSON.parse(row.scopes_json)
    : (row.scopes_json ?? ['read']);

  return {
    clientId: Number(row.client_id),
    userId: Number(row.user_id),
    plan: row.plan,
    scopes,
  };
}

export async function requireApiKey(req: NextRequest, scope = 'read'): Promise<ApiKeyContext> {
  const ctx = await validateApiKey(req);
  if (!ctx) throw new Error('Invalid or missing API key');
  if (!ctx.scopes.includes(scope) && !ctx.scopes.includes('*')) {
    throw new Error(`Missing scope: ${scope}`);
  }
  return ctx;
}

export async function listApiClients(userId: number) {
  await ensureQuantTables();
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.plan, c.active, c.created_at,
              (SELECT COUNT(*) FROM api_keys k WHERE k.client_id = c.id AND k.revoked_at IS NULL) AS key_count
         FROM api_clients c WHERE c.user_id = ? ORDER BY c.created_at DESC`,
      [userId],
    );
    return rows as any[];
  } catch {
    return [];
  }
}
