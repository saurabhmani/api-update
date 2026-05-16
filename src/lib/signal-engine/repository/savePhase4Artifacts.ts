// ════════════════════════════════════════════════════════════════
//  Phase 4 Persistence — Explanations, Outcomes, Feedback, Memory
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  SignalOutcome, DecisionMemoryEntry, PortfolioCommentary,
  SignalFreshness, MacroContext, NewsContext, EventRiskSnapshot, ContextualModifierBreakdown,
} from '../types/phase4.types';

// MySQL strict mode rejects ISO 8601 timestamps with 'T'/'Z'/fractional
// seconds (error 1292 Incorrect datetime value). Normalize at the write
// boundary so any caller — current or future — can hand us a Date or an
// ISO string and we'll persist a 'YYYY-MM-DD HH:MM:SS' value.
function toMysqlDateTime(input: string | Date | null | undefined): string | null {
  if (input == null || input === '') return null;
  const iso = input instanceof Date ? input.toISOString() : String(input);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) return iso;
  return iso.slice(0, 19).replace('T', ' ');
}

// ── Save signal outcome ────────────────────────────────────
export async function saveOutcome(outcome: SignalOutcome): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_outcomes
      (signal_id, entry_triggered, bars_to_entry,
       target1_hit, target2_hit, target3_hit, stop_hit,
       max_fav_excursion_pct, max_adv_excursion_pct,
       pnl_r, return_bar5_pct, return_bar10_pct,
       outcome_label, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      outcome.signalId,
      outcome.entryTriggered ? 1 : 0,
      outcome.barsToEntry,
      outcome.target1Hit ? 1 : 0,
      outcome.target2Hit ? 1 : 0,
      outcome.target3Hit ? 1 : 0,
      outcome.stopHit ? 1 : 0,
      outcome.maxFavorableExcursionPct,
      outcome.maxAdverseExcursionPct,
      outcome.pnlR,
      outcome.returnAtBar5Pct,
      outcome.returnAtBar10Pct,
      outcome.outcomeLabel,
      toMysqlDateTime(outcome.evaluatedAt),
    ],
  );
}

// ── Save AI explanation ────────────────────────────────────
// One row per signal, idempotent via UNIQUE(signal_id). Re-running the
// pipeline for a signal overwrites the previous explanation rather than
// appending a duplicate row.
export async function saveExplanation(
  signalId: number | string,
  explanation: Record<string, unknown>,
  contextSnapshot: Record<string, unknown>,
): Promise<void> {
  const safe = (v: unknown) =>
    JSON.stringify(v ?? {}, (_k, val) => (typeof val === 'number' && !isFinite(val) ? null : val));
  await db.query(
    `INSERT INTO q365_signal_explanations (signal_id, explanation_json, context_json, created_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       explanation_json = VALUES(explanation_json),
       context_json     = VALUES(context_json),
       created_at       = NOW()`,
    [signalId, safe(explanation), safe(contextSnapshot)],
  );
}

// ── Backfill explanations for orphan signals ──────────────
// Every row in q365_signals should have a corresponding row in
// q365_signal_explanations. Historically the Phase 4 pipeline couldn't
// reach saveExplanation (see the q365_signals schema drift around
// sector/volatility_state columns and the market_data_daily candle
// provider mismatch), so pre-existing signals landed without an
// explanation row.
//
// This helper synthesises an explanation from the signal's already-stored
// fields (direction, confidence, trade plan, regime, reasons/warnings
// from q365_signal_reasons) and saves it via the same saveExplanation
// path as the live pipeline. It's idempotent because saveExplanation
// upserts on UNIQUE(signal_id), so re-running the backfill overwrites
// rather than duplicating.
export async function backfillMissingExplanations(
  options: { batchSize?: number; limit?: number } = {},
): Promise<{ scanned: number; persisted: number; failed: number }> {
  const batchSize = options.batchSize ?? 200;
  const limit = options.limit;
  const counts = { scanned: 0, persisted: 0, failed: 0 };

  // Pull every signal that doesn't have an explanation row.
  const { rows: orphanRows } = await db.query(
    `SELECT s.id                    AS signal_id,
            s.symbol,
            s.direction,
            s.signal_type,
            s.scenario_tag,
            s.confidence_score,
            s.confidence_band,
            s.risk_score,
            s.risk_band,
            s.opportunity_score,
            s.entry_price,
            s.stop_loss,
            s.target1,
            s.target2,
            s.risk_reward,
            s.market_regime,
            s.market_stance,
            s.factor_scores_json,
            s.generated_at
       FROM q365_signals s
       LEFT JOIN q365_signal_explanations e ON e.signal_id = s.id
      WHERE e.id IS NULL
      ORDER BY s.id ASC
      ${limit ? `LIMIT ${Number(limit)}` : ''}`,
  );
  const orphans = orphanRows as any[];
  counts.scanned = orphans.length;
  if (orphans.length === 0) return counts;

  // Batch-fetch reasons + warnings for all orphan signal_ids at once.
  const ids = orphans.map((s) => s.signal_id);
  const reasonsById = new Map<number, Array<{ type: string; message: string; factor_key: string | null; contribution: number | null }>>();
  const warningsById = new Map<number, string[]>();
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const placeholders = chunk.map(() => '?').join(',');
    const { rows: reasonRows } = await db.query(
      `SELECT signal_id, reason_type, message, factor_key, contribution
         FROM q365_signal_reasons
        WHERE signal_id IN (${placeholders})
        ORDER BY id ASC`,
      chunk,
    );
    for (const r of reasonRows as any[]) {
      const sid = Number(r.signal_id);
      if (r.reason_type === 'warning') {
        const list = warningsById.get(sid) ?? [];
        list.push(r.message);
        warningsById.set(sid, list);
      } else {
        const list = reasonsById.get(sid) ?? [];
        list.push({
          type: r.reason_type,
          message: r.message,
          factor_key: r.factor_key ?? null,
          contribution: r.contribution != null ? Number(r.contribution) : null,
        });
        reasonsById.set(sid, list);
      }
    }
  }

  // Construct an explanation per orphan and upsert.
  for (const s of orphans) {
    try {
      const factorScores = typeof s.factor_scores_json === 'string'
        ? JSON.parse(s.factor_scores_json || '{}')
        : (s.factor_scores_json ?? {});
      const reasonList = reasonsById.get(s.signal_id) ?? [];
      const warningList = warningsById.get(s.signal_id) ?? [];

      const explanation = {
        source:          'backfill',
        generatedAt:     s.generated_at,
        symbol:          s.symbol,
        direction:       s.direction,
        strategy:        s.signal_type ?? 'unknown',
        scenarioTag:     s.scenario_tag ?? null,
        confidenceScore: s.confidence_score,
        confidenceBand:  s.confidence_band,
        riskScore:       s.risk_score,
        riskBand:        s.risk_band,
        opportunityScore: s.opportunity_score,
        tradePlan: {
          entry:       s.entry_price != null ? Number(s.entry_price) : null,
          stopLoss:    s.stop_loss    != null ? Number(s.stop_loss)    : null,
          target1:     s.target1      != null ? Number(s.target1)      : null,
          target2:     s.target2      != null ? Number(s.target2)      : null,
          riskReward:  s.risk_reward  != null ? Number(s.risk_reward)  : null,
        },
        reasons:      reasonList.map((r) => r.message),
        warnings:     warningList,
        factorScores,
      };

      const context = {
        source:       'backfill',
        regime:       s.market_regime ?? 'NEUTRAL',
        marketStance: s.market_stance ?? 'selective',
      };

      await saveExplanation(s.signal_id, explanation, context);
      counts.persisted++;
    } catch (err) {
      counts.failed++;
      console.error(
        `[backfillExplanations] signal_id=${s.signal_id} (${s.symbol}) failed:`,
        (err as Error).message,
      );
    }
  }
  return counts;
}

// ── Save freshness snapshot ────────────────────────────────
// Freshness decays as bars elapse after generation; persisting it
// at generation time gives us the "t=0" baseline so downstream jobs
// can recompute the decay curve and compare actuals vs model.
export async function saveFreshnessSnapshot(
  signalId: number | string,
  freshness: SignalFreshness,
  ageBars = 0,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_freshness
      (signal_id, age_bars, freshness_score, decay_state, urgency_tag, validity_window)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      signalId,
      ageBars,
      (freshness as any).freshnessScore ?? (freshness as any).score ?? 0,
      (freshness as any).decayState ?? 'fresh',
      (freshness as any).urgencyTag ?? null,
      (freshness as any).validityWindow ?? null,
    ],
  );
}

// ── Save context snapshot ──────────────────────────────────
// Spec §4.B: dedicated row per (signal, generation) with the full
// macro/news/event/modifier bundle that informed Phase 4 scoring.
// Previously this bundle was jammed into q365_signal_explanations.context_json —
// we keep writing there for back-compat but also land it here so analytics
// queries don't have to join through the explanation table.
export async function saveContextSnapshot(
  signalId: number | string,
  macro: MacroContext,
  news: NewsContext,
  eventRisk: EventRiskSnapshot,
  modifiers: ContextualModifierBreakdown,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_context_snapshots
      (signal_id, macro_context_json, news_context_json,
       event_risk_json, modifier_breakdown_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      signalId,
      JSON.stringify(macro),
      JSON.stringify(news),
      JSON.stringify(eventRisk),
      JSON.stringify(modifiers),
    ],
  );
}

// ── Save decision memory entries ───────────────────────────
export async function saveDecisionMemory(entries: DecisionMemoryEntry[]): Promise<void> {
  if (entries.length === 0) return;

  const values = entries.map((e) => [
    e.signalId,
    e.stage,
    e.message,
    JSON.stringify(e.payload),
    e.createdAt,
  ]);
  const placeholders = values.map(() => '(?, ?, ?, ?, ?)').join(', ');

  await db.query(
    `INSERT INTO q365_decision_memory (signal_id, stage, message, payload_json, created_at)
     VALUES ${placeholders}`,
    values.flat(),
  );
}

// ── Save portfolio commentary ──────────────────────────────
export async function savePortfolioCommentary(commentary: PortfolioCommentary): Promise<void> {
  await db.query(
    `INSERT INTO q365_portfolio_commentary
      (market_tone, cluster_risk, capital_deployment, watchlist_note, opportunities_note, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      commentary.marketToneSummary,
      commentary.clusterRiskSummary,
      commentary.capitalDeploymentNote,
      commentary.watchlistNote,
      commentary.topOpportunitiesNote,
    ],
  );
}

// ── Load feedback state from historical outcomes ───────────
export async function loadFeedbackState(
  strategyName: string,
  regime: string,
): Promise<{ winRate: number | null; sampleSize: number }> {
  try {
    const result: any = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN target1_hit = 1 THEN 1 ELSE 0 END) AS wins
       FROM q365_signal_outcomes o
       JOIN q365_signals s ON s.id = o.signal_id
       WHERE s.signal_type = ? AND s.market_regime = ?
       AND o.evaluated_at > DATE_SUB(NOW(), INTERVAL 90 DAY)`,
      [strategyName, regime],
    );

    const rows = result.rows ?? [];
    const row = rows[0];
    if (!row || row.total < 5) return { winRate: null, sampleSize: row?.total ?? 0 };

    return {
      winRate: Math.round((row.wins / row.total) * 100) / 100,
      sampleSize: row.total,
    };
  } catch {
    return { winRate: null, sampleSize: 0 };
  }
}

// ── Load full feedback state from adaptive recommendations + calibration ──
// Combines the latest adaptive recommendation for (strategy × regime) with
// the latest confidence calibration state into the FeedbackState used by
// the contextual modifier engine. This is the LIVE feedback loop:
// outcomes → calibration → recommendations → confidence modifiers.
import type { FeedbackState, EnvironmentFit, CalibrationState } from '../types/phase4.types';

export async function loadLiveFeedbackState(
  strategyName: string,
  regime: string,
): Promise<FeedbackState> {
  const fallback: FeedbackState = {
    strategyRecentWinRate: null,
    strategyEnvironmentFit: 'insufficient_data',
    confidenceCalibrationState: 'insufficient_data',
  };

  try {
    // 1. Recent win rate from outcomes
    const { winRate } = await loadFeedbackState(strategyName, regime);

    // 2. Latest adaptive recommendation for this strategy × regime
    const { rows: recRows } = await db.query(
      `SELECT environment_fit, recommended_modifier, evidence_strength
         FROM q365_adaptive_recommendations
        WHERE strategy_name = ? AND regime = ?
        ORDER BY computed_at DESC LIMIT 1`,
      [strategyName, regime],
    );
    const rec = (recRows as any[])[0];
    const envFit: EnvironmentFit = rec?.environment_fit ?? 'insufficient_data';

    // 3. Latest confidence calibration state for this confidence band
    //    Use the overall (non-strategy-specific) calibration as the default,
    //    but prefer strategy-specific if available.
    const { rows: calRows } = await db.query(
      `SELECT calibration_state
         FROM q365_confidence_calibration
        ORDER BY computed_at DESC LIMIT 1`,
    );
    const cal = (calRows as any[])[0];
    const calState: CalibrationState = cal?.calibration_state ?? 'insufficient_data';

    return {
      strategyRecentWinRate: winRate,
      strategyEnvironmentFit: envFit,
      confidenceCalibrationState: calState,
    };
  } catch {
    return fallback;
  }
}

// ── Idempotent ensure (runs once per process) ─────────────
let _phase4Migrated = false;
export async function ensurePhase4Tables(): Promise<void> {
  if (_phase4Migrated) return;
  await migratePhase4Tables();
  _phase4Migrated = true;
}

// ── Migration: Phase 4 tables ──────────────────────────────
export async function migratePhase4Tables(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_outcomes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      entry_triggered TINYINT(1) DEFAULT 0,
      bars_to_entry INT,
      target1_hit TINYINT(1) DEFAULT 0,
      target2_hit TINYINT(1) DEFAULT 0,
      target3_hit TINYINT(1) DEFAULT 0,
      stop_hit TINYINT(1) DEFAULT 0,
      max_fav_excursion_pct DECIMAL(8,4) DEFAULT 0,
      max_adv_excursion_pct DECIMAL(8,4) DEFAULT 0,
      pnl_r DECIMAL(8,4) DEFAULT 0,
      return_bar5_pct DECIMAL(8,4),
      return_bar10_pct DECIMAL(8,4),
      outcome_label VARCHAR(30) NOT NULL,
      evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_id (signal_id),
      INDEX idx_outcome (outcome_label),
      INDEX idx_evaluated (evaluated_at)
    )
  `);

  // Additive migration: add pnl_r column if missing on existing tables
  try {
    const { rows: outcCols } = await db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signal_outcomes'
          AND COLUMN_NAME = 'pnl_r'`,
    );
    if (outcCols.length === 0) {
      await db.query(`ALTER TABLE q365_signal_outcomes ADD COLUMN pnl_r DECIMAL(8,4) DEFAULT 0 AFTER max_adv_excursion_pct`);
      console.log('[migratePhase4Tables] q365_signal_outcomes: added column pnl_r');
    }
  } catch { /* race condition or already exists — fine */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_explanations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      explanation_json JSON,
      context_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_explanation_signal (signal_id)
    )
  `);
  // Upgrade pre-existing tables that were created with only a non-unique
  // INDEX on signal_id. Adding a UNIQUE constraint gives us idempotent
  // upserts and enforces the "one explanation per signal" invariant.
  try {
    await db.query(`ALTER TABLE q365_signal_explanations DROP INDEX idx_signal_id`);
  } catch { /* index already absent — fine */ }
  try {
    await db.query(
      `ALTER TABLE q365_signal_explanations
         ADD UNIQUE KEY uniq_explanation_signal (signal_id)`,
    );
  } catch { /* unique already present — fine */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_decision_memory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      stage VARCHAR(50) NOT NULL,
      message TEXT,
      payload_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_signal_id (signal_id),
      INDEX idx_stage (stage)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_portfolio_commentary (
      id INT AUTO_INCREMENT PRIMARY KEY,
      market_tone TEXT,
      cluster_risk TEXT,
      capital_deployment TEXT,
      watchlist_note TEXT,
      opportunities_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_freshness (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      age_bars INT NOT NULL DEFAULT 0,
      freshness_score DECIMAL(6,2) DEFAULT 0,
      decay_state VARCHAR(30),
      urgency_tag VARCHAR(30),
      validity_window VARCHAR(60),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_fresh_signal (signal_id),
      INDEX idx_fresh_state (decay_state)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_context_snapshots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      macro_context_json JSON,
      news_context_json JSON,
      event_risk_json JSON,
      modifier_breakdown_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ctx_signal (signal_id)
    )
  `);

  // Strategy performance rollups — one row per (strategy × regime ×
  // volatility_state × sector) per evaluation run. Append-only so we can
  // track drift across runs; readers should ORDER BY computed_at DESC.
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_strategy_performance_snapshots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_name VARCHAR(50) NOT NULL,
      regime VARCHAR(30) NOT NULL,
      volatility_state VARCHAR(30),
      sector VARCHAR(50),
      sample_size INT NOT NULL DEFAULT 0,
      win_rate DECIMAL(5,4) DEFAULT 0,
      target1_hit_rate DECIMAL(5,4) DEFAULT 0,
      avg_pnl_r DECIMAL(8,4) DEFAULT 0,
      avg_mfe DECIMAL(8,4) DEFAULT 0,
      avg_mae DECIMAL(8,4) DEFAULT 0,
      environment_fit VARCHAR(30),
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sps_strategy (strategy_name),
      INDEX idx_sps_regime (regime),
      INDEX idx_sps_computed (computed_at)
    )
  `);

  // Additive migration: add avg_pnl_r if missing
  try {
    const { rows: spsCols } = await db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_strategy_performance_snapshots'
          AND COLUMN_NAME = 'avg_pnl_r'`,
    );
    if (spsCols.length === 0) {
      await db.query(`ALTER TABLE q365_strategy_performance_snapshots ADD COLUMN avg_pnl_r DECIMAL(8,4) DEFAULT 0 AFTER target1_hit_rate`);
      console.log('[migratePhase4Tables] q365_strategy_performance_snapshots: added column avg_pnl_r');
    }
  } catch { /* race or exists */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_confidence_calibration (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bucket VARCHAR(10) NOT NULL,
      strategy_name VARCHAR(50),
      regime VARCHAR(30),
      sample_size INT DEFAULT 0,
      target1_hit_rate DECIMAL(5,4) DEFAULT 0,
      avg_mfe DECIMAL(8,4) DEFAULT 0,
      calibration_state VARCHAR(30),
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bucket (bucket),
      INDEX idx_strategy (strategy_name)
    )
  `);
}
