// ════════════════════════════════════════════════════════════════
//  GET  /api/manipulation-engine/scan?date=YYYY-MM-DD[&minBand=elevated]
//  POST /api/manipulation-engine/scan
//       body: { symbols: string[], date?: string, persist?: boolean }
//
//  GET  — returns all snapshots already persisted for the given date.
//  POST — runs a fresh scan over the requested symbols and (by default)
//         persists the resulting snapshots + events.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables, loadSnapshotsByDate, saveSnapshot,
} from '@/lib/manipulation-engine';
import type { SuspicionBand, ManipulationSnapshot } from '@/lib/manipulation-engine';
import { scanSymbol } from '@/lib/manipulation-engine/pipeline/runScan';
import { loadDailyBars } from '@/lib/manipulation-engine/data/candleLoader';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const date = searchParams.get('date');
    const minBand = (searchParams.get('minBand') ?? undefined) as SuspicionBand | undefined;

    if (!date) {
      return NextResponse.json({ error: 'date query param required (YYYY-MM-DD)' }, { status: 400 });
    }

    await ensureManipulationEngineTables();
    const snapshots = await loadSnapshotsByDate(date, minBand);

    return NextResponse.json({
      date,
      minBand: minBand ?? 'low',
      total: snapshots.length,
      snapshots: snapshots.map((s) => ({
        symbol: s.symbol,
        score: s.manipulationScore,
        band: s.suspicionBand,
        explanation: s.explanation,
        topEvents: s.triggeredEvents
          .filter((e) => e.triggered)
          .slice(0, 3)
          .map((e) => ({ eventType: e.eventType, severity: e.severity, label: e.detectorLabel })),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load scan snapshots', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const symbols: string[] = Array.isArray(body.symbols) ? body.symbols : [];
    const date: string | undefined = body.date;
    const persist: boolean = body.persist !== false; // default true

    if (symbols.length === 0) {
      return NextResponse.json({ error: 'symbols array required' }, { status: 400 });
    }

    await ensureManipulationEngineTables();

    const snapshots: ManipulationSnapshot[] = [];
    const errors: Array<{ symbol: string; error: string }> = [];

    for (const symbol of symbols) {
      try {
        const bars = await loadDailyBars(symbol, { asOfDate: date, lookback: 60 });
        if (bars.length < 5) {
          errors.push({ symbol, error: `insufficient bars (${bars.length})` });
          continue;
        }
        const snapshot = scanSymbol(symbol, bars, { symbol });
        if (!snapshot) {
          errors.push({ symbol, error: 'scanSymbol returned null' });
          continue;
        }
        if (persist) await saveSnapshot(snapshot);
        snapshots.push(snapshot);
      } catch (e) {
        errors.push({ symbol, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return NextResponse.json({
      requested: symbols.length,
      completed: snapshots.length,
      errors,
      snapshots: snapshots.map((s) => ({
        symbol: s.symbol,
        snapshotDate: s.snapshotDate,
        score: s.manipulationScore,
        band: s.suspicionBand,
        explanation: s.explanation,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Scan failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
