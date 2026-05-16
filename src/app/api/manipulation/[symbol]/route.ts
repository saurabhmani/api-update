// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation/:symbol[?asOf=YYYY-MM-DD]
//
//  Spec-aligned alias for the manipulation engine symbol endpoint.
//  Returns the latest persisted snapshot (or a fresh in-memory scan
//  fallback) plus risk labels + warning text.
//
//  The legacy POST/GET at /api/manipulation (the older
//  manipulation-detection subsystem) is preserved unchanged at
//  /api/manipulation/route.ts — this dynamic segment only catches
//  requests with a path parameter.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  loadLatestSnapshot,
  ensureManipulationEngineTables,
  buildHookResult,
  deriveRiskLabels,
} from '@/lib/manipulation-engine';
import { scanSymbol } from '@/lib/manipulation-engine/pipeline/runScan';
import { loadDailyBars } from '@/lib/manipulation-engine/data/candleLoader';

export async function GET(
  req: NextRequest,
  { params }: { params: { symbol: string } },
) {
  try {
    const symbol = decodeURIComponent(params.symbol || '').toUpperCase();
    if (!symbol) {
      return NextResponse.json({ error: 'symbol path param required' }, { status: 400 });
    }
    const asOf = req.nextUrl.searchParams.get('asOf') ?? undefined;

    await ensureManipulationEngineTables();

    let snapshot = await loadLatestSnapshot(symbol);
    let source: 'persisted' | 'computed' = 'persisted';

    if (!snapshot) {
      const bars = await loadDailyBars(symbol, { asOfDate: asOf, lookback: 60 });
      if (bars.length < 5) {
        return NextResponse.json(
          { error: 'insufficient candle history', symbol, barsLoaded: bars.length },
          { status: 404 },
        );
      }
      snapshot = scanSymbol(symbol, bars, { symbol });
      source = 'computed';
    }
    if (!snapshot) {
      return NextResponse.json({ error: 'no snapshot', symbol }, { status: 404 });
    }

    const hook = buildHookResult(snapshot, symbol);
    const riskLabels =
      snapshot.riskLabels && snapshot.riskLabels.length > 0
        ? snapshot.riskLabels
        : deriveRiskLabels(snapshot.triggeredEvents);

    return NextResponse.json({
      symbol,
      source,
      snapshotDate: snapshot.snapshotDate,
      score: snapshot.manipulationScore,
      band: snapshot.suspicionBand,
      riskLabels,
      warning: hook.warning,
      shouldPenalize: hook.shouldPenalize,
      shouldReject: hook.shouldReject,
      explanation: snapshot.explanation,
      topEvents: snapshot.triggeredEvents
        .filter((e) => e.triggered)
        .slice(0, 5)
        .map((e) => ({
          eventType: e.eventType,
          severity: e.severity,
          confidence: e.confidence,
          label: e.detectorLabel,
        })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
