/**
 * Admin API — Quantorus365
 *
 * New actions:
 *   get_thresholds       — view all system_thresholds
 *   set_threshold        — update a specific threshold
 *   get_stance           — current market stance details
 *   get_scenario         — current scenario details
 *   rejection_analysis   — rejection breakdown by gate
 *   set_regime           — override market regime
 *   recompute_signals    — run signal engine for top N
 *   sync_instruments_nse — instrument master sync
 */
import { NextRequest, NextResponse }    from 'next/server';
import { requireSession }               from '@/lib/session';
import { db }                           from '@/lib/db';
import { syncInstrumentsFromCdn, syncRankingsFromNse } from '@/services/dataSync';
import { generateSignal,
         persistSignal,
         logRejection }                 from '@/lib/signal-engine/live/analyzeInstrument';
import { cacheGet, cacheSet, cacheDel } from '@/lib/redis';
import { getRejectionAnalysis,
         getSignalAccuracySummary }     from '@/services/performanceTracker';
import { invalidateConfig,
         seedThresholds }              from '@/services/systemConfigService';
import { computeScenario }              from '@/services/scenarioEngine';
import { computeMarketStance }          from '@/services/marketStanceEngine';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

async function checkAdmin(req: NextRequest) {
  const user = await requireSession();
  if ((user as any).role !== 'admin') throw new Error('Admin required');
  return user;
}

export async function GET(req: NextRequest) {
  try { await checkAdmin(req); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const action = req.nextUrl.searchParams.get('action') || 'stats';

  if (action === 'stats') {
    const [accuracy, rejections] = await Promise.allSettled([
      getSignalAccuracySummary(),
      getRejectionAnalysis(),
    ]);
    return NextResponse.json({
      accuracy:   accuracy.status === 'fulfilled'   ? accuracy.value   : null,
      rejections: rejections.status === 'fulfilled' ? rejections.value : [],
    });
  }

  if (action === 'rejection_analysis') {
    return NextResponse.json({ rejections: await getRejectionAnalysis() });
  }

  if (action === 'get_thresholds') {
    const { rows } = await db.query(
      `SELECT key_name, key_value, description, updated_at FROM system_thresholds ORDER BY key_name`
    ).catch(() => ({ rows: [] }));
    return NextResponse.json({ thresholds: rows });
  }

  if (action === 'get_stance') {
    const stance   = await cacheGet<any>('market:stance');
    const scenario = await cacheGet<any>('scenario:current');
    return NextResponse.json({ stance, scenario });
  }

  if (action === 'get_scenario') {
    const scenario = await computeScenario().catch(() => null);
    return NextResponse.json({ scenario });
  }

  if (action === 'get_rejection_gates') {
    const { rows } = await db.query(`
      SELECT
        JSON_UNQUOTE(JSON_EXTRACT(rejection_reason_json, '$.codes[0]')) AS gate,
        COUNT(*) AS count,
        ROUND(COUNT(*) / (SELECT COUNT(*) FROM signal_rejections
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND approved=0) * 100, 1) AS pct
      FROM signal_rejections
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        AND approved = 0
      GROUP BY gate
      ORDER BY count DESC
      LIMIT 12
    `).catch(() => ({ rows: [] }));
    return NextResponse.json({ gates: rows });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

export async function POST(req: NextRequest) {
  try { await checkAdmin(req); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  let body: any = {};
  try { body = await req.json(); } catch {}

  // Normalise: accept both `action` and `type` keys, and map UI shorthand names
  // to the full action names used internally.
  const rawAction = body.action || body.type || req.nextUrl.searchParams.get('action') || '';
  const ACTION_ALIASES: Record<string, string> = {
    'rankings':        'sync_rankings',
    'signals':         'recompute_signals',
    'instruments-nse': 'sync_instruments_nse',
    'instruments-bse': 'sync_instruments_bse',
    'instruments-fo':  'sync_instruments_fo',
  };
  const action = ACTION_ALIASES[rawAction] ?? rawAction;

  // ── Instrument sync ───────────────────────────────────────────
  if (action === 'sync_instruments_nse') {
    const r = await syncInstrumentsFromCdn('NSE');
    return NextResponse.json({ ok: true, ...r });
  }
  if (action === 'sync_instruments_bse') {
    const r = await syncInstrumentsFromCdn('BSE');
    return NextResponse.json({ ok: true, ...r });
  }
  if (action === 'sync_instruments_fo') {
    const r = await syncInstrumentsFromCdn('NSE_FO');
    return NextResponse.json({ ok: true, ...r });
  }

  // ── Rankings sync ─────────────────────────────────────────────
  if (action === 'sync_rankings') {
    try {
      // Step 1: populate rankings table from live movers
      const r = await syncRankingsFromNse();
      // Step 2: if rankings were inserted, also prime the Redis cache
      if (r.inserted > 0) {
        const { refreshMarketUniverse } = await import('@/services/dataAggregator');
        refreshMarketUniverse().catch(() => {}); // non-blocking
      }
      return NextResponse.json({ ok: true, message: r.message });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  // ── Signal recompute ──────────────────────────────────────────
  if (action === 'recompute_signals') {
    const limit = parseInt(body.limit ?? '50');
    let ranked: any[] = [];
    try {
      const { rows } = await db.query(
        `SELECT instrument_key, tradingsymbol, exchange FROM rankings ORDER BY score DESC LIMIT ?`,
        [Math.min(limit, 200)]
      );
      ranked = rows as any[];
    } catch { return NextResponse.json({ error: 'Rankings table not found' }, { status: 503 }); }

    let approved = 0, rejected = 0, skipped = 0;
    for (const row of ranked) {
      const sig = await generateSignal(row.instrument_key, row.tradingsymbol, row.exchange);
      if (!sig) { skipped++; continue; }
      if (sig.rejection_reasons.length > 0) {
        rejected++;
        await logRejection(row.instrument_key, row.tradingsymbol, sig.rejection_reasons);
      } else {
        approved++;
        await persistSignal(sig);
      }
    }
    return NextResponse.json({
      ok: true, approved, rejected, skipped, total: ranked.length,
      approval_rate: ranked.length > 0 ? parseFloat((approved/ranked.length*100).toFixed(1)) : 0,
    });
  }

  // ── Regime override ───────────────────────────────────────────
  if (action === 'set_regime') {
    const valid = ['STRONG_BULL','BULL','NEUTRAL','CHOPPY','BEAR','STRONG_BEAR'];
    if (!valid.includes(body.regime))
      return NextResponse.json({ error: 'Invalid regime' }, { status: 400 });
    await cacheSet('market:regime', { regime: body.regime, set_by: 'admin', set_at: new Date().toISOString() }, 7200);
    // Invalidate scenario/stance caches so they recompute
    await cacheDel('scenario:current');
    await cacheDel('market:stance');
    return NextResponse.json({ ok: true, regime: body.regime, note: 'Active for 2 hours; scenario + stance will recompute' });
  }

  // ── Threshold update ──────────────────────────────────────────
  if (action === 'set_threshold') {
    const { key_name, key_value } = body;
    if (!key_name || key_value === undefined)
      return NextResponse.json({ error: 'key_name and key_value required' }, { status: 400 });
    await db.query(
      `UPDATE system_thresholds SET key_value=?, updated_at=NOW() WHERE key_name=?`,
      [String(key_value), key_name]
    );
    // Invalidate threshold cache so all engines pick up new value immediately
    await invalidateConfig();
    return NextResponse.json({ ok: true, key_name, key_value, note: 'Cache invalidated — new threshold active immediately' });
  }

  if (action === 'seed_thresholds') {
    await seedThresholds();
    return NextResponse.json({ ok: true, message: 'Default thresholds seeded to system_thresholds table' });
  }

  // ── Stance refresh ────────────────────────────────────────────
  if (action === 'refresh_stance') {
    await cacheDel('scenario:current');
    await cacheDel('market:stance');
    const scenario = await computeScenario();
    const stance   = await computeMarketStance(scenario);
    return NextResponse.json({ ok: true, scenario: scenario.scenario_tag, stance: stance.market_stance });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
