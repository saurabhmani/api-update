import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { backtestLeaseQueue, type UserCancellationResult } from '@/lib/backtesting/queue/leaseQueue';
import { normalizeStatus } from '@/lib/backtesting/runner/backtestQueue';

const notFound = () => NextResponse.json({ ok: false, error: 'Backtest not found' }, { status: 404 });

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const route = `/api/backtests/${params.id}/cancel`;
  let actor;
  try { actor = await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID();
  try {
    await ensureBacktestTables();
    const result: UserCancellationResult = actor.role === 'admin'
      ? await backtestLeaseQueue.requestAdminCancellation(params.id)
      : await backtestLeaseQueue.requestOwnedCancellation(params.id, actor.id);

    if (result.kind === 'not_found_or_unauthorized') {
      console.warn(JSON.stringify({ event: 'backtest_cancellation_denied', correlationId, actorUserId: actor.id, runId: params.id, decision: result.kind, route, timestamp: new Date().toISOString() }));
      return notFound();
    }

    const status = result.kind === 'cancelled' ? 'CANCELLED'
      : result.kind === 'cancellation_requested' ? 'RUNNING'
      : normalizeStatus(result.status);
    const reason = result.kind === 'cancellation_requested' ? 'Cancellation requested.'
      : result.kind === 'not_actionable' ? `Already in ${status} state.` : null;
    console.info(JSON.stringify({ event: 'backtest_cancellation_decision', correlationId, actorUserId: actor.id, actorRole: actor.role, runId: params.id, decision: result.kind, route, timestamp: new Date().toISOString() }));
    return NextResponse.json({ ok: true, runId: params.id, status, changed: result.changed, reason, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error(JSON.stringify({ event: 'backtest_cancellation_error', correlationId, actorUserId: actor.id, runId: params.id, route, timestamp: new Date().toISOString() }));
    return NextResponse.json({ ok: false, error: 'Cancellation failed', route, generatedAt: new Date().toISOString() }, { status: 500 });
  }
}
