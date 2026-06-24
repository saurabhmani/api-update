-- ════════════════════════════════════════════════════════════════
--  LEARNING ENGINE — FALLBACK PERSISTENCE (MySQL)
--
--  STATUS: ACTIVE FALLBACK (minimal Phase-6 shape)
--
--  Purpose:
--    Provides a migration-safe, writer-ready table so the Learning
--    Engine health probe and acceptance tests can verify persistence
--    (`SHOW TABLES`, `idx_signal`, `idx_strategy`) before the full
--    daily-report governance schema lands.
--
--  Apply (idempotent):
--    npx tsx scripts/applyLearningPersistenceMigration.ts
--
--  ── FUTURE REPLACEMENT ────────────────────────────────────────
--  This fallback is intentionally minimal. When Phase 6B wires the
--  daily-report writer, migrate to the richer schema in:
--    migrations/postgres/011_q365_daily_signal_reports.sql.proposal
--
--  Replacement steps (do NOT run until writer is ready):
--    1. Backfill signal_id / strategy_id from in-memory reviews.
--    2. Add governance columns (report_date, observation, …) via
--       additive ALTER — never DROP the fallback columns in-place.
--    3. Dual-write during cutover; retire fallback-only writers.
--    4. Optional: rename legacy daily-report columns to *_legacy
--       once consumers read the unified shape.
--
--  Safe rules:
--    - CREATE TABLE IF NOT EXISTS only (no DROP).
--    - Additive ALTER for column drift on existing installs.
--    - Legacy 011 draft NOT NULL columns relaxed to NULL so fallback
--      INSERTs (signal_id / strategy_id only) succeed during cutover.
--    - Indexes recreated only when pointing at the wrong column.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS q365_signal_learning_observations (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  signal_id       BIGINT       NULL,
  strategy_id     VARCHAR(64)  NULL,
  learning_tags   JSON         NULL,
  recommendation  VARCHAR(64)  NULL,
  reviewed_at     DATETIME     NULL,
  INDEX idx_signal   (signal_id),
  INDEX idx_strategy (strategy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
