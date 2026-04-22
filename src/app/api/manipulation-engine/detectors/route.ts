// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/detectors?symbol=TCS
//
//  Phase 2 — full per-detector breakdown for the latest snapshot.
//  Surveillance UI uses this to render the detector grid.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables,
  loadDetectorResults,
} from '@/lib/manipulation-engine';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get('symbol');
    if (!symbol) {
      return NextResponse.json({ error: 'symbol query param required' }, { status: 400 });
    }
    await ensureManipulationEngineTables();

    const { rows } = await db.query<{ id: number; snapshot_date: any; manipulation_score: number }>(
      `SELECT id, snapshot_date, manipulation_score
       FROM q365_manipulation_snapshots
       WHERE symbol = ?
       ORDER BY snapshot_date DESC
       LIMIT 1`,
      [symbol],
    );
    if (!rows[0]) {
      return NextResponse.json({ symbol, snapshotId: null, detectors: [] });
    }
    const snapshotId = rows[0].id;
    const detectors = await loadDetectorResults(snapshotId);

    return NextResponse.json({
      symbol,
      snapshotId,
      snapshotDate: typeof rows[0].snapshot_date === 'string'
        ? rows[0].snapshot_date
        : new Date(rows[0].snapshot_date).toISOString().split('T')[0],
      score: Number(rows[0].manipulation_score),
      detectors,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
