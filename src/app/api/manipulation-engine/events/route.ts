// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/events?symbol=TCS
//       [&type=probable_pump_risk][&start=YYYY-MM-DD][&end=YYYY-MM-DD][&limit=200]
//
//  Returns the event log for a symbol (or globally if no symbol).
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { ensureManipulationEngineTables, loadEvents } from '@/lib/manipulation-engine';
import type { EventType } from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const symbol = searchParams.get('symbol') ?? undefined;
    const eventType = (searchParams.get('type') ?? undefined) as EventType | undefined;
    const startDate = searchParams.get('start') ?? undefined;
    const endDate = searchParams.get('end') ?? undefined;
    const limit = parseInt(searchParams.get('limit') ?? '200', 10);

    await ensureManipulationEngineTables();
    const events = await loadEvents({ symbol, eventType, startDate, endDate, limit });

    return NextResponse.json({
      total: events.length,
      filter: { symbol, eventType, startDate, endDate, limit },
      events,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load events', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
