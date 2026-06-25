import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  acceptConsent, checkRequiredConsents, getRetentionPolicies,
  getTradingDisclaimers, getUserConsents, validateConsentType,
} from '@/lib/security';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/security/rateLimiter';
import { logSecurityEvent } from '@/lib/security/audit';
import type { ConsentType } from '@/lib/security/types';

export const dynamic = 'force-dynamic';

/** GET /api/security/compliance — consents, disclaimers, retention */
export async function GET(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const [consents, required, policies] = await Promise.all([
      getUserConsents(user.id),
      checkRequiredConsents(user.id),
      getRetentionPolicies(),
    ]);
    return NextResponse.json({
      ok: true,
      consents,
      required,
      disclaimers: getTradingDisclaimers(),
      retentionPolicies: policies,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/security/compliance — accept consent */
export async function POST(req: NextRequest) {
  try {
    await enforceRateLimit(req, RATE_LIMITS.security);
    const user = await requireSession();
    const body = await req.json();
    const consentType = validateConsentType(body.consentType) as ConsentType;
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? undefined;
    const ua = req.headers.get('user-agent') ?? undefined;

    await acceptConsent(user.id, consentType, ip ?? undefined, ua ?? undefined);
    await logSecurityEvent({
      userId: user.id,
      actorEmail: user.email,
      eventType: 'consent',
      action: 'consent.accepted',
      resource: consentType,
      ipAddress: ip ?? undefined,
    });

    return NextResponse.json({ ok: true, consentType });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed' },
      { status: 400 },
    );
  }
}
