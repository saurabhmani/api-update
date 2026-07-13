import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  loadDeployedStrategySummaries,
  loadDeploymentAuditLog,
} from '@/lib/strategy-hub/services/deploymentService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/strategies/deployments
 * Deployed strategies + deployment audit log for the current user.
 * Query: ?strategyId=&limit=
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const strategyId = req.nextUrl.searchParams.get('strategyId') ?? undefined;
    const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

    const [deployed, audit] = await Promise.all([
      loadDeployedStrategySummaries(user.id),
      loadDeploymentAuditLog({ userId: user.id, strategyId, limit }),
    ]);

    return NextResponse.json({
      ok: true,
      deployed,
      audit,
      totalDeployed: deployed.length,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
