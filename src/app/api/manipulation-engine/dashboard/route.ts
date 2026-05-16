// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/dashboard?date=YYYY-MM-DD
//
//  Phase 3 — single endpoint that returns everything the surveillance
//  dashboard needs in one round trip.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables,
  topSuspiciousSymbols,
  eventDensityByWindow,
  sectorAnomalyConcentration,
  eventTypeHistogram,
  loadAllWatchlists,
  loadRecentPenalties,
} from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    const date = req.nextUrl.searchParams.get('date')
      ?? new Date().toISOString().split('T')[0];
    await ensureManipulationEngineTables();

    // 30-day analytics window ending at `date`.
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - 30);
    const startStr = start.toISOString().split('T')[0];

    const [
      topSuspicious,
      densityShort,
      densityMid,
      densityLong,
      sectorConcentration,
      eventTypes,
      watchlists,
      recentPenalties,
    ] = await Promise.all([
      topSuspiciousSymbols(date, 25),
      eventDensityByWindow(20, date, 25),
      eventDensityByWindow(60, date, 25),
      eventDensityByWindow(120, date, 25),
      sectorAnomalyConcentration(startStr, date),
      eventTypeHistogram(startStr, date),
      loadAllWatchlists(),
      loadRecentPenalties(50),
    ]);

    return NextResponse.json({
      date,
      topSuspicious,
      eventDensity: {
        d20: densityShort,
        d60: densityMid,
        d120: densityLong,
      },
      sectorConcentration,
      eventTypes,
      watchlists,
      recentPenalties,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
