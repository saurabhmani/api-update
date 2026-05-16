// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/penalties[?signalId=...&limit=100]
//
//  Phase 2 — penalty history. Filter by signal id, otherwise return
//  the most recent N penalty rows across the system.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables,
  loadPenaltiesForSignal,
  loadRecentPenalties,
} from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    const signalId = req.nextUrl.searchParams.get('signalId');
    const limit = Number(req.nextUrl.searchParams.get('limit') ?? 100);
    await ensureManipulationEngineTables();
    const penalties = signalId
      ? await loadPenaltiesForSignal(signalId)
      : await loadRecentPenalties(limit);
    return NextResponse.json({ count: penalties.length, penalties });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
