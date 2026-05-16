// ════════════════════════════════════════════════════════════════
//  identity — skeleton
//
//  Owns: auth.users, auth.sessions, auth.audit_logs.
//  Exposes: login, session check, logout, current user lookup.
//  Publishes: nothing today (auth events are a later addition).
//
//  Crypto is wired (bcrypt + session tokens) so this service is a
//  plausible extraction target for the existing src/services/auth.ts.
// ════════════════════════════════════════════════════════════════

import '../../_shared/envLoader';
import { startHttpService, ok, err } from '../../_shared/httpService';
import { pg } from '@/lib/db/postgres';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'identity' });
const PORT = Number(process.env.IDENTITY_PORT ?? 4600);
const SESSION_TTL_SEC = Number(process.env.SESSION_MAX_AGE ?? 86400);

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

startHttpService({
  name: 'identity',
  version: '0.1.0',
  port: PORT,
  routes: [
    {
      method: 'POST',
      path: '/auth/login',
      handler: async (ctx) => {
        const body = ctx.body as { email?: string; password?: string } | undefined;
        if (!body?.email || !body?.password) {
          return err('BAD_REQUEST', 'email + password required', ctx.correlationId);
        }
        const { rows } = await pg.query<{
          id: string; password_hash: string; role: string; is_active: boolean;
        }>(
          `SELECT id, password_hash, role, is_active FROM auth.users WHERE email = $1`,
          [body.email.trim().toLowerCase()],
        );
        const user = rows[0];
        if (!user || !user.is_active) {
          return err('UNAUTHORIZED', 'invalid credentials', ctx.correlationId);
        }
        const ok2 = await bcrypt.compare(body.password, user.password_hash);
        if (!ok2) {
          return err('UNAUTHORIZED', 'invalid credentials', ctx.correlationId);
        }
        // Mint session.
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
        await pg.query(
          `INSERT INTO auth.sessions (user_id, token_hash, user_agent, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [user.id, hashToken(token), ctx.req.headers['user-agent'] ?? null, expiresAt],
        );
        await pg.query(
          `UPDATE auth.users SET last_login_at = NOW() WHERE id = $1`,
          [user.id],
        );
        return ok({
          token,
          user_id: user.id,
          role: user.role,
          expires_at: expiresAt.toISOString(),
        }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/auth/session',
      handler: async (ctx) => {
        const token = (ctx.req.headers['x-session-token'] as string) ?? ctx.query.token;
        if (!token) return err('UNAUTHORIZED', 'missing session token', ctx.correlationId);
        const { rows } = await pg.query<{ user_id: string; expires_at: Date; revoked_at: Date | null }>(
          `SELECT user_id, expires_at, revoked_at FROM auth.sessions WHERE token_hash = $1`,
          [hashToken(token)],
        );
        const s = rows[0];
        if (!s || s.revoked_at || s.expires_at <= new Date()) {
          return err('UNAUTHORIZED', 'session expired or revoked', ctx.correlationId);
        }
        return ok({ user_id: s.user_id, expires_at: s.expires_at.toISOString() }, ctx.correlationId);
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      handler: async (ctx) => {
        const token = (ctx.req.headers['x-session-token'] as string) ?? (ctx.body as { token?: string } | undefined)?.token;
        if (!token) return err('BAD_REQUEST', 'missing token', ctx.correlationId);
        await pg.query(
          `UPDATE auth.sessions SET revoked_at = NOW() WHERE token_hash = $1`,
          [hashToken(token)],
        );
        return ok({ revoked: true }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/user',
      handler: async (ctx) => {
        const userId = ctx.query.user_id;
        if (!userId) return err('BAD_REQUEST', 'user_id required', ctx.correlationId);
        const { rows } = await pg.query<{
          id: string; email: string; display_name: string | null; role: string; is_active: boolean;
        }>(
          `SELECT id, email, display_name, role, is_active FROM auth.users WHERE id = $1`,
          [userId],
        );
        if (!rows[0]) return err('NOT_FOUND', 'user not found', ctx.correlationId);
        return ok(rows[0], ctx.correlationId);
      },
    },
  ],
  probeDependencies: async () => {
    const h = await pg.healthCheck();
    return { postgres: h.ok ? 'ok' : 'down' };
  },
});
