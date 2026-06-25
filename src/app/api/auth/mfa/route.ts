import { NextRequest, NextResponse } from 'next/server';
import { handleMfaGet, handleMfaPost } from '@/lib/security/mfaService';

export const dynamic = 'force-dynamic';

/** POST /api/auth/mfa — MFA setup, confirm, disable, verify */
export async function POST(req: NextRequest) {
  try {
    return await handleMfaPost(req);
  } catch (e: unknown) {
    const status = e && typeof e === 'object' && 'statusCode' in e
      ? Number((e as { statusCode: number }).statusCode) : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unauthorized' },
      { status },
    );
  }
}

/** GET /api/auth/mfa — MFA status */
export async function GET(req: NextRequest) {
  try {
    return await handleMfaGet(req);
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
