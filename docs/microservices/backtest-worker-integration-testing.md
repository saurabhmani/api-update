# Backtest Worker MySQL integration testing

The isolated environment uses MySQL 8.4 LTS, database `quantorus_backtest_it`, port `33316`, isolated non-production credentials, and a tmpfs data directory. It does not read `.env.local`.

```powershell
docker compose -f docker-compose.backtest-integration.yml up -d --wait
npm.cmd run backtest:it:db
$env:BACKTEST_MYSQL_INTEGRATION='true'; npm.cmd run backtest:it:test
docker compose -f docker-compose.backtest-integration.yml exec backtest-mysql mysql -ubacktest_it -pintegration-only quantorus_backtest_it -e "SELECT run_id,status,processor_id,attempt_count,lease_expires_at FROM backtest_runs"
docker compose -f docker-compose.backtest-integration.yml down
```

`backtest:it:db` drops only the two tables inside the isolated integration database, recreates the legacy queue shape, applies migration 016, and records its SHA-256 checksum in `backtest_schema_migrations`. Re-running it provides a clean reset. The Vitest suite is skipped unless the explicit integration flag is true.
Migration 017 integration tests validate current/stale epoch claims for both processor types, disabled behavior, authority-transition races, processor/lease mismatches, lifecycle rejection, active-job handoff blocking, attempt preservation, and compare-and-set transition concurrency against disposable MySQL 8.4.

Migration 017 is additive and does not alter IDs, statuses, attempts, or existing payloads. Production application is prohibited without approval. A rollback requires both processors stopped/not ready, no active epoch-bound rows, and explicit database approval; then remove `idx_br_processor_epoch_lease`, the `processor_type` and `ownership_epoch` columns, and the singleton table. Never use rollback to reset attempts or delete queue rows.
The independent-process harness is `npm.cmd run backtest:two-process`. It launches the actual monolith queue entry point and worker server as separate OS processes, assigns separate ports/identities/logs, and writes `artifacts/backtest-two-process-report.json`. On the current Windows validation host, direct `tsx` startup fails before user code with `uv_os_get_passwd ENOMEM`; therefore no successful two-process evidence is claimed from this environment.
# 2026-08-04 execution environment

Linux Docker (`node v22.23.2`, x64) is the authoritative process-test environment. Windows Node v24.18.0 still fails inside `tsx` before application code at `os.userInfo()` with `uv_os_get_passwd ENOMEM`. The Linux fixture gates pass, but the first real process run failed during disposable full-schema preparation and must be repaired and rerun before parity, crash recovery, or rollback evidence can pass.
# 2026-08-04 completed local process evidence

The schema bottleneck was duplicate application of migration-016 columns: the legacy schema builder already created them before migration 016 ran. Disposable setup now builds a pre-016 baseline, applies 016 and 017 exactly once, closes its bounded pool, and bulk-loads 840 candles. Linux Node v22.23.2 process evidence passed monolith, service, disabled, SIGKILL crash, lease expiry, stale recovery, and monolith reclaim scenarios.
# 2026-08-04 completed local process evidence

The schema bottleneck was duplicate application of migration-016 columns: the legacy schema builder already created them before migration 016 ran. Disposable setup now builds a pre-016 baseline, applies 016 and 017 exactly once, closes its bounded pool, and bulk-loads 840 candles. Linux Node v22.23.2 process evidence passed monolith, service, disabled, SIGKILL crash, lease expiry, stale recovery, and monolith reclaim scenarios.
