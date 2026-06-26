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
import { requireAdmin } from '@/lib/session';
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
  const user = await requireAdmin();
  return user;
}

function mapUserRow(r: Record<string, unknown>) {
  return {
    id:            Number(r.id),
    email:         r.email,
    name:          r.name ?? null,
    role:          r.role,
    is_active:     Boolean(r.is_active),
    totp_enabled:  Boolean(r.totp_enabled),
    last_login_at: r.last_login_at ? new Date(String(r.last_login_at)).toISOString() : null,
    created_at:    r.created_at ? new Date(String(r.created_at)).toISOString() : null,
  };
}

export async function GET(req: NextRequest) {
  try { await checkAdmin(req); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const resource = req.nextUrl.searchParams.get('resource');

  if (resource === 'users') {
    try {
      const { rows } = await db.query(
        `SELECT id, email, name, role, is_active, totp_enabled, last_login_at, created_at
           FROM users
          ORDER BY created_at DESC`,
      );
      return NextResponse.json({ users: (rows as Record<string, unknown>[]).map(mapUserRow) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load users';
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (resource === 'audit') {
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 100), 500);
    try {
      const { rows } = await db.query(
        `SELECT a.id, a.user_id, a.action, a.resource_type, a.resource_id,
                a.metadata, a.ip_address, a.created_at,
                u.email AS user_email
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.created_at DESC
          LIMIT ?`,
        [limit],
      );
      return NextResponse.json({ logs: rows });
    } catch {
      return NextResponse.json({ logs: [] });
    }
  }

  if (resource === 'usage') {
    const safeCount = async (sql: string) => {
      try {
        const { rows } = await db.query(sql);
        return Number((rows[0] as { c?: number })?.c ?? 0);
      } catch {
        return 0;
      }
    };
    try {
      const [totalUsers, activeUsers, signalRows, instrumentRows] = await Promise.all([
        safeCount(`SELECT COUNT(*) AS c FROM users`),
        safeCount(`SELECT COUNT(*) AS c FROM users WHERE is_active = 1`),
        safeCount(`SELECT COUNT(*) AS c FROM q365_signals`),
        safeCount(`SELECT COUNT(*) AS c FROM instruments`),
      ]);
      return NextResponse.json({
        total_users:       totalUsers,
        active_users:      activeUsers,
        total_signals:     signalRows,
        total_instruments: instrumentRows,
      });
    } catch {
      return NextResponse.json({ total_users: 0, active_users: 0 });
    }
  }

  if (resource === 'flags') {
    return NextResponse.json({ flags: [] });
  }

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

export async function PUT(req: NextRequest) {
  let admin;
  try { admin = await checkAdmin(req); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const resource = req.nextUrl.searchParams.get('resource');
  if (resource !== 'user') {
    return NextResponse.json({ error: 'Unknown resource' }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: 'Valid user id required' }, { status: 400 });
  }

  if (id === admin.id) {
    if (body.is_active === false) {
      return NextResponse.json({ error: 'Cannot disable your own account' }, { status: 400 });
    }
    if (body.role === 'user') {
      return NextResponse.json({ error: 'Cannot demote your own admin role' }, { status: 400 });
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (body.role !== undefined) {
    const role = String(body.role);
    if (role !== 'user' && role !== 'admin') {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }
    sets.push('role = ?');
    params.push(role);
  }

  if (body.is_active !== undefined) {
    sets.push('is_active = ?');
    params.push(body.is_active ? 1 : 0);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  params.push(id);
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

  const { rows } = await db.query(
    `SELECT id, email, name, role, is_active, totp_enabled, last_login_at, created_at
       FROM users WHERE id = ?`,
    [id],
  );
  const updated = (rows as Record<string, unknown>[])[0];
  return NextResponse.json({ ok: true, user: updated ? mapUserRow(updated) : null });
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
