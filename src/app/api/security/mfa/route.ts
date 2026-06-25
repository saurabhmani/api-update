import { NextRequest } from 'next/server';
import { handleMfaGet, handleMfaPost } from '@/lib/security/mfaService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    return await handleMfaGet(req);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handleMfaPost(req);
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed' },
      { status: 400 },
    );
  }
}
