# Backtest Worker rollout and rollback

The executable staging preflight and rollback commands are defined in `backtest-worker-staging-canary.md`. Live MySQL validation uses the isolated environment in `backtest-worker-integration-testing.md`.

Before staging, the route regression suite must confirm private-by-default parent authorization across every Backtest detail, child, compare, export, cancellation, and deletion operation.

This runbook is for local validation and a future approved staging canary. It does not authorize production enablement.

## Local validation

1. Run MySQL migration `016_backtest_queue_leases.sql` and the read-only preflight.
2. Start with owner `monolith`; submit and process a test job.
3. Stop the processor, set owner `disabled`, and verify no claims.
4. Set owner `service`, explicitly enable and start the worker.
5. Submit one job; verify one claim, cancellation checkpoints, and an expired-lease recovery.
6. Stop service claims and allow active work to finish or expire.
7. Set owner `disabled`, recover expired leases, then set owner `monolith`.
8. Verify the service is stopped/not ready and the monolith processes a new job.

## Staging canary (documented, not executed)

Drain active jobs; set ownership disabled; verify neither processor claims; start the service only after configuring service ownership plus explicit enablement; submit a synthetic fixture and compare its persisted result with the monolith fixture; observe claims, leases, errors, latency, and queue age for an approved window; admit only limited staging jobs.

## Rollback

Stop new service claims, let active jobs complete or their leases expire, switch to disabled during the handoff, run stale recovery, then switch to monolith. Confirm the service cannot claim, resume the monolith drain, and reconcile queued/running rows without resetting attempt history. Never configure both owners during a handoff.
Ownership commands use `npm.cmd run backtest:ownership:show` and `npm.cmd run backtest:ownership -- transition --to disabled --expected-epoch <n> --operator <id> [--execute]`. Dry-run is the default. Direct owner switches, stale epochs, missing execution operator, and leaving disabled with active old-epoch jobs return nonzero. The command never deletes rows, resets attempts, or alters leases.

Handoff policy: advance to `disabled`; stop new claims; inventory old-epoch active jobs; allow the approved graceful window; reject old-epoch finalization; then recover only expired leases. Leave disabled only after no running or cancellation-requested rows remain.
Before any approved canary, `npm.cmd run backtest:fixture:verify`, the persisted parity report, `npm.cmd run backtest:two-process`, staging preflight, and rollback report must all pass. A valid hash alone is not fixture approval. The current fixture fails real-runner history requirements, so rollout remains blocked.
# Operational readiness evidence

Monitoring deployment and rule-verification instructions are in `backtest-monitoring-deployment.md`. The review bundle and deployment/operator/canary/rollback checklists are in `backtest-staging-approval-package.md`. Do not begin the canary while `backtest-ci-reliability-report.md` remains blocked.
