import { cookies } from 'next/headers';
import { db } from './db';
import { cacheGet, cacheSet } from './redis';
import { AuthenticationError, ForbiddenError } from './errors';

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  role: 'user' | 'admin';
}

/** Call inside any route.ts to get the logged-in user or null */
export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('q200_session')?.value;
  if (!token) return null;

  // Redis cache for speed
  const cached = await cacheGet<SessionUser>(`session:${token}`);
  if (cached) return cached;

  // Fall back to DB
  const { rows } = await db.query<SessionUser & { expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.role
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > NOW() AND u.is_active = TRUE`,
    [token]
  );

  if (!rows.length) return null;
  const user = { id: rows[0].id, email: rows[0].email, name: rows[0].name, role: rows[0].role };
  await cacheSet(`session:${token}`, user, 300);
  return user;
}

/**
 * Require session — returns user or throws AuthenticationError.
 *
 * DIGEST-CRASH-FIX-2026-05 — previously threw `new Response(...)`. A
 * Response object is NOT an Error and has no `.digest`, so when this
 * throw propagated into a Server Component / RSC render path Next.js's
 * `app-page.runtime.prod.js` crashed reading `error.digest`. Throwing
 * a proper `AuthenticationError` (extends Error, has `.message`,
 * `.statusCode`, `.code`, and a digest stamped by normalizeError())
 * keeps the framework's error path safe. Existing API route handlers
 * that did `if (err instanceof Response) ...` are unaffected because
 * their non-Response branch returns the same 401 JSON.
 */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new AuthenticationError('Unauthorized');
  return user;
}

/** Require admin role — throws ForbiddenError (proper Error subclass). */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin') throw new ForbiddenError('Forbidden');
  return user;
}
