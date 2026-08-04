# Backtest Worker staging canary

Current verdict: **No-go for staging canary** until the independent two-process persisted-parity run and rollback rehearsal produce evidence. Authorization regression is green. Migration 017 proposes a staging/integration MySQL owner+epoch authority; direct owner switches are rejected and service queue acknowledgements are epoch-scoped.

Proposed staging-only alert assumptions requiring operator approval: oldest queue age 120s; failure rate 5% over 15m; lost leases 0; heartbeat failures 0 over 5m; unexpected recoveries 0; processing p95 no more than 20% above monolith baseline; pool utilization below 80%; readiness stable for 10m; worker restarts at most 1 per hour. Hard blockers remain zero-tolerance.

> Security gate: the approved private-by-default Backtest resource boundary is implemented. Staging remains blocked until focused authorization validation and persisted parity are complete.

## Deployment model

Staging follows the existing PM2/VPS model through `deploy/staging/ecosystem.backtest-worker.config.cjs`. It binds health endpoints to loopback, starts disabled with concurrency one, contains no secrets, and has no Nginx route. Deployment must distribute the same ownership value to monolith and worker and restart both; the operator preflight compares observable state. Automatic fallback is prohibited.

## Proposed gates requiring approval

- Duplicate claims or overlapping owner epochs: exactly zero.
- Parity mismatches: exactly zero.
- Unexpected dead jobs or stale recovery: exactly zero.
- Cancellation failures: exactly zero.
- Lost lease rate, error rate, maximum queue age, pool saturation and readiness instability: thresholds must be approved from staging baseline; no production thresholds are asserted here.

Dashboard panels/alerts must cover queue depth/age, running/failed/dead jobs, monolith/service claims, conflicts, attempts, processing/wait duration, cancellation latency, heartbeat failures, lost leases, recoveries, readiness, owner mode, parity mismatches, MySQL errors, and pool utilization.

## Phase 0 — Preparation

Record approvals, environment, operators, commit, application and worker versions, migration checksums, fixture hash, parity verdict, alert deployment, audit location, and rollback operator. Require a clean staging preflight.

## Phase 1 — Monolith baseline

Keep authoritative owner `monolith` and worker disabled/not ready. Submit the approved deterministic fixture through the monolith, capture all persistence, queue timing, authorization evidence, and baseline performance.

## Phase 2 — Disabled transition

Isolate new submissions, drain active work, transition `monolith -> disabled` with a new epoch, verify both processors are not ready and neither claims, then rerun preflight.

## Phase 3 — Worker activation

Transition `disabled -> service`, enable exactly one worker, verify worker readiness and monolith denial, run the same fixture, require persisted parity, and inspect logs, metrics, leases, and heartbeat behavior.

## Phase 4 — Limited cohort

Process only an approved staging cohort at concurrency one. Exercise completion, queued/running cancellation, administrator access, cross-user denial, controlled restart, and controlled stale recovery.

## Phase 5 — Soak

Run for the approved duration and monitor every zero-tolerance blocker plus approved queue age, duration, pool, readiness, restart, and error thresholds.

## Phase 6 — Mandatory rollback

Isolate submissions, transition `service -> disabled`, drain or expire active leases, stop the worker, recover only expired jobs, transition `disabled -> monolith`, replay the fixture through monolith, reconcile every queue state, and generate the rollback audit report. Perform this phase even when the service canary otherwise succeeds.

## Evidence collection

Preserve preflight JSON, process logs, owner epochs, parity and rollback reports, fixture manifest, queue snapshots, dashboard exports, alerts, incidents, authorization checks, cancellations, restart/recovery evidence, deviations, and the final go/no-go recommendation. Do not pre-fill success.

Run `npm.cmd run backtest:staging:preflight` before each transition. Run `npm.cmd run backtest:rollback` first as a dry run; after both deployments show `disabled`, `npm.cmd run backtest:rollback -- --execute-recovery` may recover only expired leases. The script never deletes data, resets attempts, or silently changes deployment configuration.
Ownership prerequisite: preflight must observe one MySQL authority row, migrations 016/017, valid owner/epoch, matching process intent, concurrency one, safe lease/heartbeat relationship, and no obsolete active epochs. Persisted parity remains `not-executed`; this ownership milestone does not authorize canary execution.
Current hard blockers: deterministic fixture readiness fails (insufficient bars), persisted parity remains `not-executed`, the independent-process harness could not start on the current Windows host because the TypeScript runtime fails before user code, and a process-backed crash/rollback rehearsal is not complete. The canary must not begin.
# Current gate (2026-08-04)

**No-go. Do not execute the canary.** Fixture v2 is statically suitable and exercises the production signal pipeline, but real monolith persistence, real worker persistence, zero-mismatch parity, two-process ownership scenarios, crash recovery, rollback rehearsal, and integrated live-endpoint preflight have not passed.
# Updated gate after local executable evidence

Local engineering evidence now passes schema initialization, real processor execution, persisted parity, process ownership, crash recovery, rollback, and integrated preflight. Canary execution remains **NO-GO** until dashboard/alert deployment with firing evidence and repeated Linux CI runs establish duration, consistency, and flake-rate evidence and receive approval.
# Updated gate after local executable evidence

Local engineering evidence now passes schema initialization, real processor execution, persisted parity, process ownership, crash recovery, rollback, and integrated preflight. Canary execution remains **NO-GO** until dashboard/alert deployment with firing evidence and repeated Linux CI runs establish duration, consistency, and flake-rate evidence and receive approval.
# Operational evidence update

The existing dashboard was provisioned into Grafana 12.1.0, all eight rules loaded into Prometheus 3.5.0, the scrape target was healthy, and deterministic promtool tests proved every alert fires and returns to normal at its configured duration. Repeated authoritative GitHub Actions runs and measured flake rate remain missing; the canary gate therefore remains closed.
