import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import { runScheduledAiAnalysis } from '@/lib/strategy-hub/services/strategyAiService';

export const dynamic = 'force-dynamic';

type AiJob =
  | 'daily_review'
  | 'weekly_optimization'
  | 'monthly_executive'
  | 'anomaly_detection'
  | 'recommendation_refresh';

const VALID_JOBS = new Set<AiJob>([
  'daily_review',
  'weekly_optimization',
  'monthly_executive',
  'anomaly_detection',
  'recommendation_refresh',
]);

/**
 * POST /api/strategies/ai/analysis — trigger scheduled AI analysis (admin)
 * Body: { job: AiJob }
 */
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const job = String(body.job ?? '') as AiJob;
    if (!VALID_JOBS.has(job)) {
      return NextResponse.json({ ok: false, error: 'Invalid job' }, { status: 400 });
    }

    const result = await runScheduledAiAnalysis(
      job,
      admin.email ?? `user:${admin.id}`,
    );
    return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.ok ? 200 : 400 });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'AI analysis failed' }, { status: 500 });
  }
}
