// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine?symbol=TCS[&asOf=YYYY-MM-DD]
//
//  Returns the latest manipulation snapshot for a symbol. If no
//  persisted snapshot exists, the engine runs a fresh scan from
//  the candles table and returns (without persisting — persistence
//  is the scan endpoint's job).
//
//  Route note: the legacy /api/manipulation route belongs to the
//  older manipulation-detection subsystem. The new Phase 1 engine
//  lives under /api/manipulation-engine to avoid colliding with it.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  loadLatestSnapshot,
  ensureManipulationEngineTables,
} from '@/lib/manipulation-engine';
import { scanSymbol } from '@/lib/manipulation-engine/pipeline/runScan';
import { loadDailyBars } from '@/lib/manipulation-engine/data/candleLoader';
import { buildHookResult } from '@/lib/manipulation-engine/api/signalEngineHooks';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const symbol = searchParams.get('symbol');
    const asOf = searchParams.get('asOf') ?? undefined;

    if (!symbol) {
      return NextResponse.json({ error: 'symbol query param required' }, { status: 400 });
    }

    await ensureManipulationEngineTables();

    // Prefer a persisted snapshot; fall back to a fresh in-memory scan.
    let snapshot = await loadLatestSnapshot(symbol);
    let source: 'persisted' | 'computed' = 'persisted';

    if (!snapshot) {
      const bars = await loadDailyBars(symbol, { asOfDate: asOf, lookback: 60 });
      if (bars.length < 5) {
        return NextResponse.json(
          { error: 'insufficient candle history for symbol', symbol, barsLoaded: bars.length },
          { status: 404 },
        );
      }
      snapshot = scanSymbol(symbol, bars, { symbol });
      source = 'computed';
    }

    if (!snapshot) {
      return NextResponse.json({ error: 'no snapshot', symbol }, { status: 404 });
    }

    return NextResponse.json({
      source,
      snapshot,
      hook: buildHookResult(snapshot, symbol),
      evidencePreview: snapshot.triggeredEvents
        .filter((e) => e.triggered)
        .slice(0, 3)
        .map((e) => ({
          eventType: e.eventType,
          severity: e.severity,
          confidence: e.confidence,
          label: e.detectorLabel,
          topEvidence: e.evidence.slice(0, 3),
        })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load manipulation snapshot', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
