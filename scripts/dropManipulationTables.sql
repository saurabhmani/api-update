-- ════════════════════════════════════════════════════════════════
--  scripts/dropManipulationTables.sql
--
--  No-Node fallback for the manipulation table schema-drift fix.
--  Use this when `npm run fix:manipulation -- --force` isn't an option
--  (e.g. you don't have tsx / node_modules on the machine, or you want
--  to run the fix directly from a MySQL client like Workbench / DBeaver).
--
--  Run from bash on the VPS:
--    mysql -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" \
--      < scripts/dropManipulationTables.sql
--
--  Or paste into MySQL Workbench connected to your `quantorus365` DB.
--
--  After running this, restart the app — `ensureManipulationEngineTables()`
--  will run on the next /api/manipulation request and rebuild the tables
--  with the canonical schema from
--  src/lib/manipulation-engine/repository/migrate.ts.
--
--    pm2 restart quantorus365     # production
--    npm run dev                   # local
--
--  Data note:
--  The whole point of this script is that the existing schema is
--  unusable by the app — any rows already in these tables can't be read
--  by the current code. Dropping is therefore non-destructive in
--  practice; you're not losing data the system can use.
-- ════════════════════════════════════════════════════════════════

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS q365_manipulation_calibration_snapshots;
DROP TABLE IF EXISTS q365_manipulation_watchlist_history;
DROP TABLE IF EXISTS q365_manipulation_watchlists;
DROP TABLE IF EXISTS q365_manipulation_detector_results;
DROP TABLE IF EXISTS q365_manipulation_penalties;
DROP TABLE IF EXISTS q365_signal_manipulation_links;
DROP TABLE IF EXISTS q365_manipulation_snapshots;
DROP TABLE IF EXISTS q365_manipulation_events;

SET FOREIGN_KEY_CHECKS = 1;

-- Sanity check: should return 0 rows
SELECT TABLE_NAME
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME LIKE 'q365_manipulation%';
