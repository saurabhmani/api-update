// ════════════════════════════════════════════════════════════════
//  POST /api/signals/:id/lifecycle
//
//  Append a lifecycle transition to a signal. Phase 3 §8.
//
//  Body:
//    { state: 'approved' | 'ready' | 'entered' | 'exited' |
//             'invalidated' | 'expired' | 'rejected' | 'archived',
//      reason: string,
//      changedAt?: string (ISO timestamp, defaults to now) }
//
//  Rules enforced here:
//    - signal must exist
//    - state must be in ALLOWED_LIFECYCLE_STATES
//    - reason is required (non-empty)
//    - transitions are append-only; existing rows are never updated
//    - chronological order is enforced by passing changedAt through
//      unchanged — the GET endpoint sorts ASC on changed_at
//
//  Response:
//    { signal_id, state, reason, changed_at, lifecycle_history_length }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import {
  transitionSignalLifecycle,
  ALLOWED_LIFECYCLE_STATES,
  type LifecycleState,
} from '@/lib/signal-engine/repository/savePhase3Signals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const signalId = parseInt(params.id, 10);
  if (!signalId || Number.isNaN(signalId)) {
    return NextResponse.json(
      { error: 'Invalid signal id' },
      { status: 400 },
    );
  }

  let body: { state?: string; reason?: string; changedAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const state = body.state;
  const reason = body.reason?.trim();
  const changedAt = body.changedAt ?? new Date().toISOString();

  if (!state || !ALLOWED_LIFECYCLE_STATES.includes(state as LifecycleState)) {
    return NextResponse.json(
      {
        error: `Invalid state. Must be one of: ${ALLOWED_LIFECYCLE_STATES.join(', ')}`,
      },
      { status: 400 },
    );
  }
  if (!reason) {
    return NextResponse.json(
      { error: 'reason is required' },
      { status: 400 },
    );
  }

  try {
    // Verify signal exists before appending — avoids orphan lifecycle
    // rows that would confuse later audits.
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM q365_signals WHERE id = ? LIMIT 1`,
      [signalId],
    );
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Signal not found' },
        { status: 404 },
      );
    }

    await transitionSignalLifecycle(
      signalId,
      state as LifecycleState,
      reason,
      changedAt,
    );

    // Return the current history length so callers can confirm the
    // append landed without a second round-trip.
    const countResult = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM q365_signal_lifecycle WHERE signal_id = ?`,
      [signalId],
    );

    return NextResponse.json({
      signal_id: signalId,
      state,
      reason,
      changed_at: changedAt,
      lifecycle_history_length: Number(countResult.rows[0]?.n ?? 0),
    });
  } catch (err) {
    console.error(`[/api/signals/${signalId}/lifecycle]`, err);
    return NextResponse.json(
      {
        error: 'Failed to append lifecycle transition',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
