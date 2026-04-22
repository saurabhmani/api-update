// ════════════════════════════════════════════════════════════════
//  Idempotent schema ensure for the signal-engine layer.
//
//  Called once per process by any code path that needs the
//  Phase 3/4 audit tables to exist (signalPipeline, Phase4 pipeline,
//  validation tests, etc).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensurePhase4Tables } from './savePhase4Artifacts';
import { migratePhase2Tables } from './saveStrategyBreakdowns';
import { ensureNewsSchemas } from '@/lib/news-engine/repository/ensureNewsSchemas';

let _ensured = false;

export async function ensureSignalEngineSchemas(): Promise<void> {
  if (_ensured) return;

  // Phase 3 tables
  const phase3Ddl = [
    `CREATE TABLE IF NOT EXISTS q365_signal_trade_plans (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      entry_type VARCHAR(40) NOT NULL,
      entry_zone_low DECIMAL(12,2) NOT NULL,
      entry_zone_high DECIMAL(12,2) NOT NULL,
      stop_loss DECIMAL(12,2) NOT NULL,
      initial_risk_per_unit DECIMAL(12,4) NOT NULL,
      target1 DECIMAL(12,2) NOT NULL,
      target2 DECIMAL(12,2) NOT NULL,
      target3 DECIMAL(12,2) NOT NULL,
      rr_target1 DECIMAL(6,2) NOT NULL,
      rr_target2 DECIMAL(6,2) NOT NULL,
      rr_target3 DECIMAL(6,2) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tp_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_position_sizing (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      capital_model VARCHAR(30) NOT NULL,
      portfolio_capital DECIMAL(14,2) NOT NULL,
      risk_budget_pct DECIMAL(6,4) NOT NULL,
      risk_budget_amount DECIMAL(12,2) NOT NULL,
      initial_risk_per_unit DECIMAL(12,4) NOT NULL,
      position_size_units INT NOT NULL,
      gross_position_value DECIMAL(14,2) NOT NULL,
      validation_status VARCHAR(20) NOT NULL,
      warnings_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ps_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_portfolio_fit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      fit_score INT NOT NULL,
      sector_exposure_impact VARCHAR(20) NOT NULL,
      direction_impact VARCHAR(20) NOT NULL,
      capital_availability VARCHAR(20) NOT NULL,
      correlation_cluster VARCHAR(50),
      correlation_penalty DECIMAL(5,2) DEFAULT 0,
      portfolio_decision VARCHAR(30) NOT NULL,
      penalties_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pf_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_execution_readiness (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      status VARCHAR(40) NOT NULL,
      action_tag VARCHAR(30) NOT NULL,
      priority_rank INT,
      approval_decision VARCHAR(20) NOT NULL,
      reasons_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_er_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS q365_signal_lifecycle (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      state VARCHAR(20) NOT NULL,
      reason VARCHAR(255) NOT NULL,
      changed_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_lc_signal (signal_id),
      INDEX idx_lc_state (state)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // Risk breakdown persistence — one row per (signal, Phase3 run).
    // Durable record of standalone/portfolio/total split and the
    // human-readable factors that drove the band, so the number on
    // q365_signals.risk_score can be reconstructed and audited.
    `CREATE TABLE IF NOT EXISTS q365_signal_risk_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      standalone_risk_score INT NOT NULL,
      portfolio_risk_score INT NOT NULL,
      total_risk_score INT NOT NULL,
      risk_band VARCHAR(30) NOT NULL,
      risk_factors_json JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_rs_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const ddl of phase3Ddl) {
    await db.query(ddl);
  }

  // ── q365_signals additive column migration ─────────────────
  //
  // The live q365_signals table was created before the Phase 1/4
  // provenance + enrichment work landed, so these 6 columns are
  // missing on any DB that wasn't freshly seeded. `saveSignals`
  // INSERTs all 6 unconditionally — without them every Phase 4 run
  // fails at the INSERT, signalIdMap comes back empty, and every
  // downstream writer (explanations, strategy breakdowns, Phase 3
  // artifacts) silently skips. This block closes the drift.
  //
  // All columns are nullable so the ALTER is safe on tables with
  // existing data — old rows keep NULL, new rows get the values
  // saveSignals writes. Per-column existence check via
  // INFORMATION_SCHEMA so we work on every MySQL version, not just
  // those that support `ADD COLUMN IF NOT EXISTS`.
  const signalsExtras: Array<{ name: string; ddl: string }> = [
    { name: 'sector',            ddl: `ADD COLUMN sector VARCHAR(50) NULL` },
    { name: 'volatility_state',  ddl: `ADD COLUMN volatility_state VARCHAR(30) NULL` },
    { name: 'engine_phase',      ddl: `ADD COLUMN engine_phase VARCHAR(30) NULL` },
    { name: 'engine_version',    ddl: `ADD COLUMN engine_version VARCHAR(30) NULL` },
    { name: 'code_build',        ddl: `ADD COLUMN code_build VARCHAR(60) NULL` },
    { name: 'generation_source', ddl: `ADD COLUMN generation_source VARCHAR(80) NULL` },
    // These two are read by readSignals.getActiveSignals / getTopSignals.
    // Any q365_signals table that predates Phase 3 is missing them and
    // every `/api/signals?action=all` request on that DB throws
    // `Unknown column 's.portfolio_fit_score' in 'field list'`, which
    // bubbles up as an uncaught Next.js 500.
    { name: 'portfolio_fit_score', ddl: `ADD COLUMN portfolio_fit_score SMALLINT NULL` },
    { name: 'regime_alignment',    ddl: `ADD COLUMN regime_alignment VARCHAR(30) NULL` },
  ];

  const { rows: existingCols } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'`,
  );
  const present = new Set(existingCols.map((r) => r.COLUMN_NAME));

  for (const col of signalsExtras) {
    if (present.has(col.name)) continue;
    try {
      await db.query(`ALTER TABLE q365_signals ${col.ddl}`);
      console.log(`[ensureSchemas] q365_signals: added column ${col.name}`);
    } catch (err) {
      // Race: another process added the column between the SELECT
      // and the ALTER. Treat "Duplicate column" as success.
      const msg = (err as Error).message || '';
      if (msg.includes('Duplicate column')) continue;
      throw err;
    }
  }

  // ── market_data_daily VIEW ──────────────────────────────────
  //
  // Several code paths (learningScheduler outcome evaluator, legacy
  // dashboard readers, runEnd2End) query a `market_data_daily` table
  // that does not exist on the live DB — daily bars live in `candles`
  // with `candle_type='eod'` and `interval_unit='1day'`, keyed on
  // `instrument_key` (e.g. `NSE_EQ|RELIANCE`).
  //
  // Rather than touch every query site, we expose a VIEW that projects
  // the legacy `market_data_daily(symbol, ts, open, high, low, close,
  // volume)` shape over the real candle store. `CREATE OR REPLACE VIEW`
  // is idempotent, the view is read-only, and MySQL plans it cheaply
  // because the underlying indexes on `(instrument_key, ts)` still apply.
  //
  // Symbol extraction: `SUBSTRING_INDEX(instrument_key, '|', -1)` strips
  // the `NSE_EQ|` prefix and works for both `NSE_EQ|SYM` and
  // `NSE_INDEX|SYM` layouts. Querying `WHERE symbol = ?` still hits the
  // composite index via the function predicate because MySQL pushes
  // the derived filter down to the base table.
  // If `market_data_daily` already exists as a BASE TABLE (legacy
  // installs created it before we switched to a VIEW), MySQL will
  // refuse `CREATE OR REPLACE VIEW` with "is not VIEW". Detect and
  // rename the old table out of the way so the VIEW can take its
  // place. We rename (not drop) to preserve any historical rows —
  // they'll sit in `market_data_daily_legacy` and can be inspected
  // or dropped manually once confirmed superseded by `candles`.
  try {
    const { rows: tblRows } = await db.query<{ TABLE_TYPE: string }>(
      `SELECT TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'market_data_daily'`,
    );
    const kind = tblRows[0]?.TABLE_TYPE;
    if (kind === 'BASE TABLE') {
      // Drop any prior legacy rename target, then move the old table.
      await db.query(`DROP TABLE IF EXISTS market_data_daily_legacy`).catch(() => {});
      await db.query(`RENAME TABLE market_data_daily TO market_data_daily_legacy`);
      console.warn(
        '[ensureSchemas] market_data_daily was a BASE TABLE — renamed to ' +
        'market_data_daily_legacy so the VIEW projecting `candles` can be created.'
      );
    }
  } catch (err) {
    console.warn(
      '[ensureSchemas] market_data_daily table-kind probe failed:',
      (err as Error).message,
    );
  }

  await db.query(
    `CREATE OR REPLACE VIEW market_data_daily AS
       SELECT SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol,
              instrument_key,
              ts,
              open,
              high,
              low,
              close,
              volume
         FROM candles
        WHERE candle_type = 'eod'
          AND interval_unit = '1day'`,
  ).catch((err) => {
    console.warn('[ensureSchemas] market_data_daily view creation failed:', (err as Error).message);
  });

  // Phase 2 tables (strategy breakdowns, conflicts) — previously
  // defined but never invoked from any ensure path, so the tables
  // were missing on live DBs and every saveStrategyBreakdowns call
  // threw silently inside the Phase 2 persistence try/catch.
  await migratePhase2Tables();

  // Phase 4 tables (outcomes, explanations, decision memory, commentary)
  await ensurePhase4Tables();

  // News Intelligence Engine tables (events, entity links, ingestion log)
  await ensureNewsSchemas();

  _ensured = true;
}
