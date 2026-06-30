// Public Signals API — optional API key + IP rate limiting

import { createHash } from 'crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { AuthenticationError } from '@/lib/errors';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';
import { ensureQuantTables } from '@/lib/quant-platform/repository/quantRepository';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function lookupApiKeyContext(req: NextRequest): Promise<{
  clientId: number;
  plan: string;
  scopes: string[];
} | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const rawKey = auth.slice(7).trim();
  if (!rawKey.startsWith('q365_')) return null;

  await ensureQuantTables();
  const { rows } = await db.query(
    `SELECT k.id, k.client_id, k.scopes_json, c.plan, c.active
       FROM api_keys k
       JOIN api_clients c ON c.id = k.client_id
      WHERE k.key_hash = ? AND k.revoked_at IS NULL AND c.active = 1`,
    [hashKey(rawKey)],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  await db.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = ?`, [row.id]);

  const scopes = typeof row.scopes_json === 'string'
    ? JSON.parse(row.scopes_json as string)
    : ((row.scopes_json as string[]) ?? ['read']);

  return {
    clientId: Number(row.client_id),
    plan: String(row.plan ?? 'pro'),
    scopes,
  };
}

export async function enforcePublicSignalsAccess(req: NextRequest): Promise<void> {
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const rawKey = auth.slice(7).trim();
    if (!rawKey.startsWith('q365_')) {
      throw new AuthenticationError('Invalid API key format');
    }
    const ctx = await lookupApiKeyContext(req);
    if (!ctx) {
      throw new AuthenticationError('Invalid or expired API key');
    }
    if (!ctx.scopes.includes('read') && !ctx.scopes.includes('*')) {
      throw new AuthenticationError('Missing scope: read');
    }
    const max = ctx.plan === 'enterprise' ? 300 : RATE_LIMITS.publicSignalsKey.max;
    await enforceRateLimit(req, {
      ...RATE_LIMITS.publicSignalsKey,
      keyPrefix: `${RATE_LIMITS.publicSignalsKey.keyPrefix}:${ctx.clientId}`,
      max,
    });
    return;
  }

  await enforceRateLimit(req, RATE_LIMITS.publicSignals);
}
