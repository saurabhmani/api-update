// GET /api/operations/release — Release manifest (Phase 5)
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { buildReleaseManifest, releaseManifestToJson } from '@/lib/operations/releaseGovernance';
import { validateDeployment } from '@/lib/operations/deploymentValidation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const generatedAt = new Date().toISOString();
  const deployment = validateDeployment({
    generatedAt,
    databaseConnected: undefined,
    sessionSecretPresent: Boolean(process.env.SESSION_SECRET),
  });
  const manifest = buildReleaseManifest({
    generatedAt,
    validationResult: deployment,
  });

  return NextResponse.json({
    ok: true,
    manifest,
    json: releaseManifestToJson(manifest),
  });
}
