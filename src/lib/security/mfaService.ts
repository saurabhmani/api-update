// MFA service — shared handler for /api/auth/mfa and /api/security/mfa

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { initTotp, confirmTotp, verifyTotp } from '@/services/auth';
import { db } from '@/lib/db';
import { enforceRateLimit, RATE_LIMITS } from './rateLimiter';
import { logSecurityEvent } from './audit';
import { validateTotpToken } from './validation';

export async function handleMfaPost(req: NextRequest) {
  await enforceRateLimit(req, RATE_LIMITS.security);
  const user = await requireSession();
  const body = await req.json();
  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? undefined;

  if (body.action === 'setup') {
    const result = await initTotp(user.id, user.email);
    await logSecurityEvent({
      userId: user.id,
      actorEmail: user.email,
      eventType: 'mfa',
      action: 'mfa.setup_initiated',
      ipAddress: ip ?? undefined,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  if (body.action === 'confirm') {
    const token = validateTotpToken(body.token ?? '');
    const valid = await confirmTotp(user.id, token);
    if (!valid) return NextResponse.json({ ok: false, error: 'Invalid token' }, { status: 400 });
    await logSecurityEvent({
      userId: user.id,
      actorEmail: user.email,
      eventType: 'mfa',
      action: 'mfa.enabled',
      ipAddress: ip ?? undefined,
    });
    return NextResponse.json({ ok: true, mfaEnabled: true });
  }

  if (body.action === 'disable') {
    const token = validateTotpToken(body.token ?? '');
    const valid = await verifyTotp(user.id, token);
    if (!valid) return NextResponse.json({ ok: false, error: 'Invalid token' }, { status: 400 });
    await db.query(`UPDATE users SET totp_enabled=FALSE, totp_secret=NULL WHERE id=?`, [user.id]);
    await logSecurityEvent({
      userId: user.id,
      actorEmail: user.email,
      eventType: 'mfa',
      action: 'mfa.disabled',
      ipAddress: ip ?? undefined,
    });
    return NextResponse.json({ ok: true, mfaEnabled: false });
  }

  if (body.action === 'verify') {
    const token = validateTotpToken(body.token ?? '');
    const valid = await verifyTotp(user.id, token);
    return NextResponse.json({ ok: valid, valid });
  }

  return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
}

export async function handleMfaGet(req: NextRequest) {
  await enforceRateLimit(req, RATE_LIMITS.security);
  const user = await requireSession();
  const { rows } = await db.query(`SELECT totp_enabled FROM users WHERE id = ?`, [user.id]);
  return NextResponse.json({ ok: true, mfaEnabled: Boolean((rows[0] as any)?.totp_enabled) });
}
