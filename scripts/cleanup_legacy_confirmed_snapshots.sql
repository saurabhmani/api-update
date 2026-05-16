-- ════════════════════════════════════════════════════════════════
--  scripts/cleanup_legacy_confirmed_snapshots.sql
--
--  ONE-SHOT cleanup for q365_confirmed_signal_snapshots rows that
--  predate the tightened promotion gates introduced in
--  src/lib/signal-engine/repository/confirmedSnapshots.ts:
--
--      validation_cycles_passed   >= 3
--      maturity_score             >= 85
--      confidence_score           >= 75
--      final_score                >= 70   (when present)
--      rr_ratio                   >= 2
--      expected_edge_percent      >  2
--
--  Strategy: SOFT-DELETE. We flip status ACTIVE → INVALIDATED and
--  stamp invalidation_reason with the precise violation. The row
--  itself is preserved for audit. No data is dropped or archived
--  to a sidecar table — the same row is the audit record.
--
--  Scope: only rows currently in status='ACTIVE'. Rows already in a
--  terminal state (TARGET_HIT, STOP_LOSS_HIT, INVALIDATED, EXPIRED)
--  completed their lifecycle and must not be retroactively rewritten.
--
--  NULL semantics:
--    - validation_cycles_passed IS NULL → treated as a violation
--      (the new gate requires the field; an ACTIVE row missing it
--      cannot satisfy "cycles >= 3" and should not remain ACTIVE).
--    - maturity_score IS NULL → same reasoning.
--    - final_score IS NULL → NOT a violation. The production writer
--      skips the final_score check when null, so legacy rows that
--      predate the field are left ACTIVE (other gates still apply).
--
--  Multi-violation rows: tagged by the FIRST violation found, in
--  priority order: cycles → maturity → confidence → final_score →
--  rr_ratio → edge. The priority matches the writer's check order
--  in insertConfirmedSnapshotIfEligible() so the reason code reads
--  the same way an engineer reads the gate stack.
--
--  Idempotent: re-running invalidates nothing because every target
--  row will already be status='INVALIDATED' after the first run.
--
--  Usage (MySQL):
--      mysql -u <user> -p <database> < scripts/cleanup_legacy_confirmed_snapshots.sql
--
--  To dry-run, change `COMMIT;` at the bottom to `ROLLBACK;` — the
--  before/after SELECTs still print so you can preview impact.
-- ════════════════════════════════════════════════════════════════

START TRANSACTION;

-- ─── BEFORE: total ACTIVE rows about to be reviewed ────────────
SELECT
    'before_total_active' AS metric,
    COUNT(*)              AS rows_value
FROM q365_confirmed_signal_snapshots
WHERE status = 'ACTIVE';

-- ─── BEFORE: count of ACTIVE rows that violate at least one gate
SELECT
    'before_violators' AS metric,
    COUNT(*)           AS rows_value
FROM q365_confirmed_signal_snapshots
WHERE status = 'ACTIVE'
  AND (
         validation_cycles_passed IS NULL
      OR validation_cycles_passed < 3
      OR maturity_score           IS NULL
      OR maturity_score           < 85
      OR confidence_score         < 75
      OR (final_score IS NOT NULL AND final_score < 70)
      OR rr_ratio                 < 2
      OR expected_edge_percent    <= 2
  );

-- ─── BEFORE: per-violation breakdown.
--  Note: each row may violate multiple gates and is counted once
--  per violation here (so the sum can exceed `before_violators`).
--  This is the diagnostic view; the UPDATE below tags each row by
--  its primary (first-priority) violation only.
SELECT 'cycles_violators'     AS violation, COUNT(*) AS rows_value
  FROM q365_confirmed_signal_snapshots
 WHERE status = 'ACTIVE'
   AND (validation_cycles_passed IS NULL OR validation_cycles_passed < 3)
UNION ALL
SELECT 'maturity_violators',     COUNT(*)
  FROM q365_confirmed_signal_snapshots
 WHERE status = 'ACTIVE'
   AND (maturity_score IS NULL OR maturity_score < 85)
UNION ALL
SELECT 'confidence_violators',   COUNT(*)
  FROM q365_confirmed_signal_snapshots
 WHERE status = 'ACTIVE'
   AND confidence_score < 75
UNION ALL
SELECT 'final_score_violators',  COUNT(*)
  FROM q365_confirmed_signal_snapshots
 WHERE status = 'ACTIVE'
   AND final_score IS NOT NULL
   AND final_score < 70
UNION ALL
SELECT 'rr_violators',           COUNT(*)
  FROM q365_confirmed_signal_snapshots
 WHERE status = 'ACTIVE'
   AND rr_ratio < 2
UNION ALL
SELECT 'edge_violators',         COUNT(*)
  FROM q365_confirmed_signal_snapshots
 WHERE status = 'ACTIVE'
   AND expected_edge_percent <= 2;

-- ─── THE UPDATE ─────────────────────────────────────────────────
--  Single statement so the operation is atomic. CASE picks the
--  highest-priority violation as the reason tag.
UPDATE q365_confirmed_signal_snapshots
   SET status              = 'INVALIDATED',
       status_changed_at   = NOW(),
       invalidation_reason = CASE
           WHEN validation_cycles_passed IS NULL OR validation_cycles_passed < 3
                                                  THEN 'legacy_low_cycles'
           WHEN maturity_score IS NULL OR maturity_score < 85
                                                  THEN 'legacy_low_maturity'
           WHEN confidence_score < 75             THEN 'legacy_low_confidence'
           WHEN final_score IS NOT NULL AND final_score < 70
                                                  THEN 'legacy_low_final_score'
           WHEN rr_ratio < 2                      THEN 'legacy_low_rr'
           WHEN expected_edge_percent <= 2        THEN 'legacy_low_edge'
           ELSE                                        'legacy_multi_violation'
       END
 WHERE status = 'ACTIVE'
   AND (
         validation_cycles_passed IS NULL
      OR validation_cycles_passed < 3
      OR maturity_score           IS NULL
      OR maturity_score           < 85
      OR confidence_score         < 75
      OR (final_score IS NOT NULL AND final_score < 70)
      OR rr_ratio                 < 2
      OR expected_edge_percent    <= 2
   );

-- ─── AFTER: rows newly invalidated by this run, by reason ──────
--  Only counts rows whose invalidation_reason starts with `legacy_`
--  so re-runs (where rows are already INVALIDATED with one of
--  these tags) still report the same totals.
SELECT
    invalidation_reason   AS reason,
    COUNT(*)              AS rows_value
FROM q365_confirmed_signal_snapshots
WHERE status = 'INVALIDATED'
  AND invalidation_reason IN (
        'legacy_low_cycles',
        'legacy_low_maturity',
        'legacy_low_confidence',
        'legacy_low_final_score',
        'legacy_low_rr',
        'legacy_low_edge',
        'legacy_multi_violation'
      )
GROUP BY invalidation_reason
ORDER BY invalidation_reason;

-- ─── AFTER: residual violators still ACTIVE.
--  This MUST be 0 after the UPDATE. If it is not, the cleanup
--  failed and the transaction should be rolled back.
SELECT
    'after_residual_active_violators' AS metric,
    COUNT(*)                          AS rows_value
FROM q365_confirmed_signal_snapshots
WHERE status = 'ACTIVE'
  AND (
         validation_cycles_passed IS NULL
      OR validation_cycles_passed < 3
      OR maturity_score           IS NULL
      OR maturity_score           < 85
      OR confidence_score         < 75
      OR (final_score IS NOT NULL AND final_score < 70)
      OR rr_ratio                 < 2
      OR expected_edge_percent    <= 2
  );

-- ─── AFTER: total ACTIVE rows remaining ─────────────────────────
SELECT
    'after_total_active' AS metric,
    COUNT(*)             AS rows_value
FROM q365_confirmed_signal_snapshots
WHERE status = 'ACTIVE';

-- Change to ROLLBACK; for a dry-run preview.
COMMIT;
