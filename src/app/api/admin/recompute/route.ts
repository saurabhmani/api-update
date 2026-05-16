import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { recomputeTopSetups } from '@/services/tradeSetupGenerator';
import { generateSignalsForWatchlist } from '@/lib/signal-engine/live/analyzeInstrument';
import { db } from '@/lib/db';
import { cacheDel } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  const { type = 'all', limit = 40 } = await req.json().catch(() => ({}));

  const start = Date.now();
  let result: Record<string, unknown> = {};

  if (type === 'signals' || type === 'all') {
    const { rows } = await db.query(`SELECT instrument_key, tradingsymbol, exchange FROM rankings ORDER BY score DESC LIMIT ?`, [limit]);
    const signals = await generateSignalsForWatchlist(rows);
    result.signals_generated = signals.length;
    // Bust signal cache
    await cacheDel('signal_rules:active');
  }

  if (type === 'setups' || type === 'all') {
    const r = await recomputeTopSetups(limit);
    result = { ...result, ...r };
  }

  // Log execution
  await db.query(
    `INSERT INTO rule_execution_logs (rule_key, signals_generated, duration_ms, status)
     VALUES (?,?,?,'success')`,
    [type, result.signals_generated ?? 0, Date.now() - start]
  );

  return NextResponse.json({ success: true, type, duration_ms: Date.now() - start, ...result });
}

