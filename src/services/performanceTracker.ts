/**
 * Performance Tracker
 *
 * Tracks signal and setup outcomes broken down by:
 *   - Strategy (scenario_tag)
 *   - Regime at signal time
 *   - Confidence band (50–65 / 65–80 / 80+)
 *   - Risk band (Low / Medium / High)
 *   - Sector
 *   - False positive rate
 *   - Rejection outcome analysis
 *
 * Data written to:
 *   - signal_performance        (per-signal outcome)
 *   - strategy_performance      (aggregated by strategy × regime)
 *   - signal_quality_events     (rejections and flags)
 *
 * Called by the scheduler after market close each day.
 */

import { db }              from '@/lib/db';
import { fetchQuote }      from './marketQuote';
import { updateSetupStatus } from './tradeSetupGenerator';

// ── Check pending signal performance rows ─────────────────────────

export async function checkSignalPerformance(): Promise<void> {
  let rows: any[] = [];
  try {
    const result = await db.query(`
      SELECT sp.id, sp.signal_id, sp.direction, sp.entry_price,
             sp.stop_loss, sp.target1, sp.validity_end,
             s.tradingsymbol, s.scenario_tag, s.regime, s.confidence
      FROM signal_performance sp
      JOIN signals s ON s.id = sp.signal_id
      WHERE sp.outcome = 'pending'
        AND (sp.validity_end IS NULL OR sp.validity_end > NOW())
    `);
    rows = result.rows;
  } catch { return; }

  for (const row of rows) {
    const quote = await fetchQuote(row.tradingsymbol);
    if (!quote) continue;

    const ltp = quote.lastPrice;
    let outcome: string | null = null;
    let pnlPct = 0;

    if (row.direction === 'BUY') {
      if (row.target1 && ltp >= row.target1) {
        outcome = 'target_hit';
        pnlPct  = ((ltp - row.entry_price) / row.entry_price) * 100;
      } else if (row.stop_loss && ltp <= row.stop_loss) {
        outcome = 'sl_hit';
        pnlPct  = ((ltp - row.entry_price) / row.entry_price) * 100;
      }
    } else if (row.direction === 'SELL') {
      if (row.target1 && ltp <= row.target1) {
        outcome = 'target_hit';
        pnlPct  = ((row.entry_price - ltp) / row.entry_price) * 100;
      } else if (row.stop_loss && ltp >= row.stop_loss) {
        outcome = 'sl_hit';
        pnlPct  = ((row.entry_price - ltp) / row.entry_price) * 100;
      }
    }

    if (outcome) {
      await db.query(`
        UPDATE signal_performance
        SET outcome=?, exit_price=?, pnl_pct=?, hit_time=NOW(), checked_at=NOW()
        WHERE id=?
      `, [outcome, ltp, parseFloat(pnlPct.toFixed(2)), row.id]).catch(() => {});

      // Update strategy performance aggregation
      await updateStrategyPerformance(
        row.scenario_tag,
        row.regime,
        row.confidence,
        outcome
      );
    }
  }
}

// ── Update strategy × regime performance table ────────────────────

async function updateStrategyPerformance(
  strategyKey: string | null,
  regime:      string | null,
  confidence:  number | null,
  outcome:     string
): Promise<void> {
  if (!strategyKey) return;

  const confidenceBand =
    (confidence ?? 0) >= 80 ? '80-100' :
    (confidence ?? 0) >= 65 ? '65-80'  : '50-65';

  try {
    // Upsert into strategy_performance
    await db.query(`
      INSERT INTO strategy_performance
        (strategy_key, regime, confidence_band, period_start, period_end,
         signals_total, signals_win, signals_loss)
      VALUES (?, ?, ?, CURDATE(), CURDATE(), 1,
        IF(? = 'target_hit', 1, 0),
        IF(? = 'sl_hit', 1, 0))
      ON DUPLICATE KEY UPDATE
        signals_total = signals_total + 1,
        signals_win   = signals_win + IF(VALUES(signals_win) > 0, 1, 0),
        signals_loss  = signals_loss + IF(VALUES(signals_loss) > 0, 1, 0),
        hit_rate      = ROUND(signals_win / NULLIF(signals_win + signals_loss, 0) * 100, 1),
        updated_at    = NOW()
    `, [strategyKey, regime ?? 'NEUTRAL', confidenceBand, outcome, outcome]);
  } catch {}
}

// ── Check trade setup performance ────────────────────────────────

export async function checkSetupPerformance(): Promise<void> {
  let rows: any[] = [];
  try {
    const result = await db.query(`
      SELECT tsp.id, tsp.setup_id, tsp.direction, tsp.entry_price,
             tsp.stop_loss, tsp.target1,
             ts.tradingsymbol
      FROM trade_setup_performance tsp
      JOIN trade_setups ts ON ts.id = tsp.setup_id
      WHERE tsp.outcome = 'pending'
    `);
    rows = result.rows;
  } catch { return; }

  for (const row of rows) {
    const quote = await fetchQuote(row.tradingsymbol);
    if (!quote) continue;

    const ltp = quote.lastPrice;

    if (row.direction === 'BUY') {
      if (row.target1 && ltp >= row.target1) {
        const pnl = ((ltp - row.entry_price) / row.entry_price) * 100;
        await db.query(`
          UPDATE trade_setup_performance
          SET outcome='target_hit', exit_price=?, pnl_pct=?, hit_time=NOW(), checked_at=NOW()
          WHERE id=?
        `, [ltp, parseFloat(pnl.toFixed(2)), row.id]).catch(() => {});
        await updateSetupStatus(row.setup_id, 'target_hit', ltp, 'Target 1 hit');
      } else if (row.stop_loss && ltp <= row.stop_loss) {
        const pnl = ((ltp - row.entry_price) / row.entry_price) * 100;
        await db.query(`
          UPDATE trade_setup_performance
          SET outcome='sl_hit', exit_price=?, pnl_pct=?, hit_time=NOW(), checked_at=NOW()
          WHERE id=?
        `, [ltp, parseFloat(pnl.toFixed(2)), row.id]).catch(() => {});
        await updateSetupStatus(row.setup_id, 'stop_loss_hit', ltp, 'Stop loss hit');
      }
    }
  }
}

// ── Expire stale pending rows ─────────────────────────────────────

export async function expireOldPerformance(): Promise<void> {
  await db.query(`
    UPDATE signal_performance SET outcome='expired', checked_at=NOW()
    WHERE outcome='pending' AND validity_end < NOW()
  `).catch(() => {});
}

// ── Summary analytics (used by admin) ────────────────────────────

export async function getSignalAccuracySummary(): Promise<{
  total:           number;
  target_hit:      number;
  sl_hit:          number;
  expired:         number;
  pending:         number;
  accuracy_pct:    number;
  by_strategy:     Array<{ strategy: string; regime: string; win_rate: number; signals: number }>;
  by_confidence:   Array<{ band: string; win_rate: number; signals: number }>;
}> {
  const { rows } = await db.query(`
    SELECT outcome, COUNT(*) AS count FROM signal_performance GROUP BY outcome
  `).catch(() => ({ rows: [] }));

  const map: Record<string, number> = {};
  rows.forEach((r: any) => map[r.outcome] = parseInt(r.count));
  const total  = Object.values(map).reduce((a,b) => a+b, 0);
  const hit    = map.target_hit ?? 0;
  const closed = (map.target_hit ?? 0) + (map.sl_hit ?? 0);

  // Strategy breakdown
  const { rows: strat } = await db.query(`
    SELECT strategy_key AS strategy, regime,
           ROUND(signals_win / NULLIF(signals_win + signals_loss, 0) * 100, 1) AS win_rate,
           signals_total AS signals
    FROM strategy_performance
    ORDER BY signals_total DESC
    LIMIT 20
  `).catch(() => ({ rows: [] }));

  // Confidence breakdown
  const { rows: conf } = await db.query(`
    SELECT
      CASE
        WHEN s.confidence >= 80 THEN '80-100'
        WHEN s.confidence >= 65 THEN '65-80'
        ELSE '50-65'
      END AS band,
      ROUND(
        SUM(CASE WHEN sp.outcome='target_hit' THEN 1 ELSE 0 END) /
        NULLIF(SUM(CASE WHEN sp.outcome IN ('target_hit','sl_hit') THEN 1 ELSE 0 END), 0) * 100
      , 1) AS win_rate,
      COUNT(*) AS signals
    FROM signal_performance sp
    JOIN signals s ON s.id = sp.signal_id
    WHERE sp.outcome != 'pending'
    GROUP BY band
  `).catch(() => ({ rows: [] }));

  return {
    total,
    target_hit:    hit,
    sl_hit:        map.sl_hit    ?? 0,
    expired:       map.expired   ?? 0,
    pending:       map.pending   ?? 0,
    accuracy_pct:  closed > 0 ? parseFloat((hit / closed * 100).toFixed(1)) : 0,
    by_strategy:   strat as any[],
    by_confidence: conf  as any[],
  };
}

// ── Rejection analysis (admin quality dashboard) ──────────────────

export async function getRejectionAnalysis(): Promise<Array<{
  reason_prefix: string;
  count:         number;
  pct_of_total:  number;
}>> {
  try {
    const { rows } = await db.query(`
      SELECT
        SUBSTRING_INDEX(details, ':', 1) AS reason_prefix,
        COUNT(*)                          AS count
      FROM signal_quality_events
      WHERE event_type = 'REJECTED'
        AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY reason_prefix
      ORDER BY count DESC
      LIMIT 15
    `);
    const total = (rows as any[]).reduce((s: number, r: any) => s + Number(r.count), 0);
    return (rows as any[]).map((r: any) => ({
      reason_prefix: r.reason_prefix,
      count:         Number(r.count),
      pct_of_total:  total > 0 ? parseFloat((Number(r.count) / total * 100).toFixed(1)) : 0,
    }));
  } catch {
    return [];
  }
}
