// Session Management — list, revoke, enforce limits

import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { cacheDel } from '@/lib/redis';
import type { SessionInfo } from './types';
import { writeSecurityAudit } from './repository/securityRepository';

const MAX_SESSIONS_PER_USER = parseInt(process.env.MAX_SESSIONS_PER_USER ?? '5', 10);

export async function listUserSessions(userId: number): Promise<SessionInfo[]> {
  const cookieStore = await cookies();
  const currentToken = cookieStore.get('q200_session')?.value;

  const { rows } = await db.query(
    `SELECT id, device, ip_address, created_at, expires_at, token
       FROM user_sessions
      WHERE user_id = ? AND expires_at > NOW()
      ORDER BY created_at DESC`,
    [userId],
  );

  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    device: r.device,
    ipAddress: r.ip_address,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    isCurrent: currentToken ? r.token === currentToken : false,
  }));
}

export async function revokeSession(sessionId: number, userId: number, actorEmail?: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT token FROM user_sessions WHERE id = ? AND user_id = ?`,
    [sessionId, userId],
  );
  if (!rows.length) return false;
  const token = (rows[0] as any).token;
  await db.query(`DELETE FROM user_sessions WHERE id = ?`, [sessionId]);
  await cacheDel(`session:${token}`);
  await writeSecurityAudit({
    userId,
    actorEmail,
    eventType: 'session',
    action: 'session.revoke',
    resource: `session:${sessionId}`,
  });
  return true;
}

export async function revokeAllSessions(userId: number, exceptCurrent = true, actorEmail?: string): Promise<number> {
  const cookieStore = await cookies();
  const currentToken = exceptCurrent ? cookieStore.get('q200_session')?.value : null;

  let query = `SELECT id, token FROM user_sessions WHERE user_id = ?`;
  const params: unknown[] = [userId];
  if (currentToken) {
    query += ` AND token != ?`;
    params.push(currentToken);
  }

  const { rows } = await db.query(query, params);
  for (const row of rows as Array<{ id: number; token: string }>) {
    await db.query(`DELETE FROM user_sessions WHERE id = ?`, [row.id]);
    await cacheDel(`session:${row.token}`);
  }

  await writeSecurityAudit({
    userId,
    actorEmail,
    eventType: 'session',
    action: 'session.revoke_all',
    detail: { count: rows.length },
  });

  return rows.length;
}

export async function enforceSessionLimit(userId: number): Promise<void> {
  const { rows } = await db.query(
    `SELECT id, token FROM user_sessions
      WHERE user_id = ? AND expires_at > NOW()
      ORDER BY created_at ASC`,
    [userId],
  );
  const sessions = rows as Array<{ id: number; token: string }>;
  if (sessions.length <= MAX_SESSIONS_PER_USER) return;

  const toRemove = sessions.slice(0, sessions.length - MAX_SESSIONS_PER_USER);
  for (const s of toRemove) {
    await db.query(`DELETE FROM user_sessions WHERE id = ?`, [s.id]);
    await cacheDel(`session:${s.token}`);
  }
}

export async function countActiveSessions(userId: number): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS c FROM user_sessions WHERE user_id = ? AND expires_at > NOW()`,
    [userId],
  );
  return Number((rows[0] as any)?.c ?? 0);
}
