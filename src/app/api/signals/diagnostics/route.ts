// ════════════════════════════════════════════════════════════════
//  GET /api/signals/diagnostics
//
//  Operator endpoint for understanding why the main /signals table
//  is empty (or full). Reports:
//
//    - Schema status: do the new tables exist?
//    - Live scanner: how many q365_signals rows, when was the last detection?
//    - Maturity layer: tracker counts by stage, top candidates by score,
//      "why each one isn't promoted yet" reasons
//    - Confirmed snapshots: counts by status, last confirmation
//    - Market hours
//
//  Always uncached. Read-only. Auth-gated like the rest of /api/signals.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getTrackerCounts } from '@/lib/signal-engine/repository/maturityTracker';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

async function safeQuery<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] } | { error: string }> {
  try {
    return await db.query<T>(sql, params);
  } catch (err: any) {
    return { error: String(err?.message ?? err) };
  }
}

async function tableExists(table: string): Promise<boolean> {
  const r = await safeQuery<{ c: number }>(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  if ('error' in r) return false;
  return Number((r.rows[0] as any)?.c ?? 0) > 0;
}

export async function GET(): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // 1. Schema check — confirm both new tables exist.
  const [trackerExists, snapshotsExists, signalsExists] = await Promise.all([
    tableExists('q365_signal_maturity_tracker'),
    tableExists('q365_confirmed_signal_snapshots'),
    tableExists('q365_signals'),
  ]);
  const schemaReady = trackerExists && snapshotsExists && signalsExists;

  // 2. Live scanner stats
  const liveScannerRes = signalsExists
    ? await safeQuery<{ total: number; active: number; latest_ts: number | null; latest_batch: string | null }>(
        `SELECT
           (SELECT COUNT(*) FROM q365_signals)                                      AS total,
           (SELECT COUNT(*) FROM q365_signals
             WHERE status IN ('active','watchlist','flagged')
               AND (invalidation_reason IS NULL OR invalidation_reason NOT IN (
                 'stop_loss_broken','stop_loss_broken_confirmed',
                 'target_reached','target_already_reached',
                 'engine_disagree','live_rejected'))
               AND (expires_at IS NULL OR expires_at > NOW())
               AND decay_state <> 'expired')                                        AS active,
           (SELECT UNIX_TIMESTAMP(MAX(generated_at)) FROM q365_signals)              AS latest_ts,
           (SELECT batch_id FROM q365_signals WHERE batch_id IS NOT NULL
              ORDER BY generated_at DESC LIMIT 1)                                    AS latest_batch`,
      )
    : null;
  const liveScannerRow = liveScannerRes && !('error' in liveScannerRes)
    ? (liveScannerRes.rows[0] as any) ?? {}
    : {};
  const liveScanner = {
    total_rows:        Number(liveScannerRow.total ?? 0),
    active_rows:       Number(liveScannerRow.active ?? 0),
    latest_detection:  liveScannerRow.latest_ts
      ? new Date(Number(liveScannerRow.latest_ts) * 1000).toISOString()
      : null,
    latest_batch_id:   liveScannerRow.latest_batch ?? null,
    error:             liveScannerRes && 'error' in liveScannerRes ? liveScannerRes.error : null,
  };

  // 3. Maturity tracker stats
  const trackerCounts = trackerExists ? await getTrackerCounts() : null;

  // Top in-progress candidates with "why not promoted" reasons.
  const topCandidates = trackerExists ? await safeQuery<any>(
    `SELECT t.symbol, t.direction, t.stage, t.maturity_score, t.stable,
            t.validation_cycles_passed,
            t.first_detected_at, t.last_seen_at, t.last_evaluated_at,
            t.conviction_level, t.maturity_factors_json,
            s.scenario_tag, s.classification, s.market_regime,
            s.confidence_score, s.final_score, s.risk_reward
       FROM q365_signal_maturity_tracker t
       LEFT JOIN q365_signals s ON s.id = t.last_signal_id
      WHERE t.stage IN ('candidate','developing','mature')
      ORDER BY t.stage = 'mature' DESC,
               t.stage = 'developing' DESC,
               t.maturity_score DESC
      LIMIT 25`,
  ) : null;

  const now = Date.now();
  const candidates = topCandidates && !('error' in topCandidates)
    ? (topCandidates.rows as any[]).map((r) => {
        const detected = r.first_detected_at instanceof Date ? r.first_detected_at.getTime()
                       : typeof r.first_detected_at === 'string' ? Date.parse(r.first_detected_at.includes('T') ? r.first_detected_at : r.first_detected_at.replace(' ', 'T') + 'Z')
                       : 0;
        const ageMin = detected > 0 ? Math.round((now - detected) / 60_000) : 0;
        const reasons: string[] = [];
        if (r.stage === 'candidate') reasons.push(`maturity_score ${Number(r.maturity_score).toFixed(0)} < 70`);
        else if (r.stage === 'developing') reasons.push(`maturity_score ${Number(r.maturity_score).toFixed(0)} < 85`);
        if (r.validation_cycles_passed < 3) reasons.push(`only ${r.validation_cycles_passed} cycle(s) — needs ≥3`);
        // strategy-specific seasoning floor
        const strategy = String(r.scenario_tag ?? '').toUpperCase();
        const minAge = strategy === 'BREAKOUT_CONTINUATION' ? 15
                     : strategy === 'PULLBACK_IN_TREND'     ? 25
                     : strategy === 'MEAN_REVERSION'        ? 35
                     : 10;
        if (ageMin < minAge) reasons.push(`age ${ageMin}m — needs ≥${minAge}m for ${strategy || 'unknown'}`);
        if (Number(r.stable ?? 0) !== 1) reasons.push('not yet stable across cycles');
        if (Number(r.confidence_score ?? 0) < 75)  reasons.push(`confidence ${r.confidence_score} < 75 (writer floor)`);
        if (r.final_score != null && Number(r.final_score) < 70) reasons.push(`final_score ${Number(r.final_score).toFixed(0)} < 70 (writer floor)`);
        if (r.risk_reward != null && Number(r.risk_reward) < 2.0) reasons.push(`RR ${Number(r.risk_reward).toFixed(1)} < 2.0 (writer floor)`);
        // Regime gate proxy — read maturity_factors_json if present.
        const factors = (() => {
          if (!r.maturity_factors_json) return null;
          if (typeof r.maturity_factors_json === 'string') {
            try { return JSON.parse(r.maturity_factors_json); } catch { return null; }
          }
          return r.maturity_factors_json;
        })();
        if (Array.isArray(factors)) {
          const regimeFactor = factors.find((f: any) => f?.name === 'regime_alignment');
          if (regimeFactor && Number(regimeFactor.raw) < 0.5) {
            reasons.push(`regime gate: ${r.direction} in ${r.market_regime ?? 'NEUTRAL'} — alignment ${(Number(regimeFactor.raw) * 100).toFixed(0)}%`);
          }
        }
        return {
          symbol:                   r.symbol,
          direction:                r.direction,
          stage:                    r.stage,
          maturity_score:           Number(r.maturity_score),
          conviction_level:         r.conviction_level,
          stable:                   Number(r.stable ?? 0) === 1,
          validation_cycles_passed: Number(r.validation_cycles_passed),
          signal_age_minutes:       ageMin,
          strategy:                 r.scenario_tag,
          classification:           r.classification,
          market_regime:            r.market_regime,
          confidence_score:         r.confidence_score,
          final_score:              r.final_score != null ? Number(r.final_score) : null,
          risk_reward:              r.risk_reward != null ? Number(r.risk_reward) : null,
          last_evaluated_at:        r.last_evaluated_at,
          why_not_promoted:         reasons,
        };
      })
    : [];

  // 4. Confirmed snapshots stats
  const snapshotsCounts = snapshotsExists ? await safeQuery<{ status: string; c: number }>(
    `SELECT status, COUNT(*) AS c FROM q365_confirmed_signal_snapshots GROUP BY status`,
  ) : null;
  const snapshotsByStatus: Record<string, number> = {
    ACTIVE: 0, TARGET_HIT: 0, STOP_LOSS_HIT: 0, INVALIDATED: 0, EXPIRED: 0,
  };
  if (snapshotsCounts && !('error' in snapshotsCounts)) {
    for (const r of snapshotsCounts.rows as any[]) {
      const status = String(r.status).toUpperCase();
      if (status in snapshotsByStatus) snapshotsByStatus[status] = Number(r.c ?? 0);
    }
  }
  const lastConfirmedRes = snapshotsExists ? await safeQuery<{ ts: number | null }>(
    `SELECT UNIX_TIMESTAMP(MAX(confirmed_at)) AS ts FROM q365_confirmed_signal_snapshots`,
  ) : null;
  const lastConfirmedTs = lastConfirmedRes && !('error' in lastConfirmedRes)
    ? (lastConfirmedRes.rows[0] as any)?.ts
    : null;

  // 5. Final body
  const market = getMarketStatus();
  return NextResponse.json(
    {
      server_now: new Date().toISOString(),
      market: {
        is_open:    market.isOpen,
        state:      market.state,
        label:      market.label,
      },
      schema: {
        ready:                                  schemaReady,
        q365_signals_exists:                    signalsExists,
        q365_signal_maturity_tracker_exists:    trackerExists,
        q365_confirmed_signal_snapshots_exists: snapshotsExists,
        hint: schemaReady
          ? null
          : 'One or more tables missing. Run `npm run db:ensure` or restart Next so the boot-time migration fires.',
      },
      live_scanner: liveScanner,
      maturity_layer: {
        tracker_counts: trackerCounts,
        top_candidates: candidates,
        promotion_thresholds: {
          min_maturity_score: 85,
          min_cycles:         3,
          min_age_minutes_by_strategy: {
            BREAKOUT_CONTINUATION: 15,
            PULLBACK_IN_TREND:     25,
            MEAN_REVERSION:        35,
            DEFAULT:               10,
          },
          regime_gate_threshold: 0.5,
        },
        writer_floors: {
          confidence:             75,
          final_score:            70,
          rr_ratio:               2.0,
          expected_edge_percent:  2.0,
        },
      },
      confirmed_snapshots: {
        by_status:              snapshotsByStatus,
        latest_confirmed_at:    lastConfirmedTs ? new Date(Number(lastConfirmedTs) * 1000).toISOString() : null,
        active_count:           snapshotsByStatus.ACTIVE,
      },
      interpretation: (() => {
        if (!schemaReady) {
          return 'Migration has not run. Restart Next.js (or `npm run db:ensure`) to create the missing tables.';
        }
        if (liveScanner.active_rows === 0) {
          return 'Live scanner has not produced any active signals. Check the regen cron / market hours / candle freshness.';
        }
        if (!trackerCounts || trackerCounts.total === 0) {
          return 'Live scanner is producing rows but no maturity trackers exist. saveSignals may be silently failing — check server logs for `[saveSignals] maturity-tracker path threw`.';
        }
        if (snapshotsByStatus.ACTIVE > 0) {
          return 'System is healthy — confirmed snapshots are being promoted.';
        }
        const next = candidates.find((c) => c.stage === 'mature') ?? candidates[0] ?? null;
        if (next) {
          return `System is alive and seasoning. ${trackerCounts.total} trackers (${trackerCounts.candidate} candidate, ${trackerCounts.developing} developing, ${trackerCounts.mature} mature pending promotion). Top: ${next.symbol} ${next.direction} score=${next.maturity_score.toFixed(0)} stage=${next.stage}.`;
        }
        return `${trackerCounts.total} trackers exist but none are above score 30. The maturity worker may not be running — check logs for [MATURITY] entries.`;
      })(),
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
