-- 015_align_rankings_instruments_collation.sql
--
-- Problem:
--   /api/ticker → getTopRankings → fetchFromMySQL joins
--     rankings.instrument_key  (utf8mb4_0900_ai_ci)
--     q365_signals.instrument_key (utf8mb4_unicode_ci)
--   MySQL ER_CANT_AGGREGATE_2COLLATIONS (errno 1267) on '='.
--
-- Canonical collation (project-wide for market/signal joins):
--   utf8mb4_unicode_ci
-- Justification:
--   q365_* tables already normalize to unicode_ci (migrateSignalEngine).
--   setup.ts creates the database with unicode_ci. unicode_ci is
--   MySQL 5.7 / 8 / 9 and MariaDB compatible; 0900_ai_ci is MySQL 8+.
--
-- Scope (targeted — do NOT convert the entire schema here):
--   rankings, instruments  (ticker JOIN participants + same identity keys)
--   database default        (so new tables stop inheriting 0900_ai_ci)
--
-- Rollback (reverts table defaults only; data preserved):
--   ALTER TABLE rankings CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--   ALTER TABLE instruments CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--   -- Then re-break the ticker JOIN unless q365_signals is also converted.
--
-- Runtime path: also applied idempotently by
--   src/lib/db/normalizeTickerCollations.ts via ensureAllSchemas().

-- Align database default for future CREATE TABLE without explicit COLLATE.
ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE rankings
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE instruments
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Join support for rankings.instrument_key = q365_signals.instrument_key
-- (column had no index; post-collation-fix plans were full-table nested loops).
CREATE INDEX idx_q365_signals_ikey_gen
  ON q365_signals (instrument_key, generated_at);
