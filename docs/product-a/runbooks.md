# Product A — Operational Runbooks (Phase 5)

## Market Feed Outage

1. Check `GET /api/operations/health` → `market_data` component
2. Verify candle warehouse: `SELECT MAX(ts) FROM candles`
3. Check provider quota / scheduler logs
4. Run `npm run candles:daily` if EOD batch missed
5. Alert resolves when `market_data` returns `healthy`

## Scheduler Failure

1. Check `q365_learning_job_runs` for failed jobs
2. Run `npm run learning-scheduler` manually
3. Inspect job error_msg in counts_json
4. Fail-isolated: other jobs continue; fix failing job only

## Database Outage

1. `GET /api/health` → database check
2. Verify MySQL process + connection pool
3. Check `DATABASE_URL` / credentials (rotate if expired)
4. Block deployment: `npm run validate:deployment` exits 1

## Promotion Rollback

1. Identify active parameter: `q365_adaptive_parameter_pointer`
2. Use `rollbackParameter(parameterId, actor, reason)` 
3. Verify runtime: `getRuntimeSignalEngineConfig()` shows base config
4. Audit trail in `q365_adaptive_parameter_audit`

## Learning Rollback

1. `activateLearningSnapshot(priorSnapshotId, { rollback: true })`
2. Pointer changes only — snapshots immutable
3. Signal generation unaffected (analytics pointer only)

## Failed Release

1. Check `releases/manifest-*.json` validationStatus
2. Redeploy prior git commit
3. Run `npm run validate:deployment` before traffic
4. Run `npm run check:signal-consistency`

## Degraded Performance

1. Review `GET /api/operations/dashboard` pipeline timings
2. Check scheduler job durations in learning jobs
3. Review market feed latency component
4. No automatic parameter changes

## High Alert Volume

1. `GET /api/operations/alerts` — group by category
2. Resolve root cause per category (see above)
3. Resolved alerts emitted when condition clears
4. Escalate `critical` alerts to on-call
