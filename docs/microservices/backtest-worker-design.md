# Backtest Worker design

## Verified pre-milestone behavior

The authoritative queue was `backtest_runs` in MySQL. Submission inserted `queued` then dispatched an in-process promise; the scheduler and manual BFF endpoint also drained rows. A conditional `UPDATE ... WHERE status='queued'` limited double claims, but processor identity, attempts, heartbeat, lease and stale-running recovery were absent. Progress was persisted through the runner callback. Queued cancellation existed; running cancellation was not cooperative. Processing was asynchronous to HTTP but remained inside the monolith, using the existing engine and persistence transaction boundaries.

## Lease implementation

The monolith and service now share the conditional-update lease adapter and existing runner/persistence adapter. Claims record processor, attempt, versions, heartbeat and expiry. Repository defaults remain monolith ownership plus a disabled service. Cancellation checkpoints run during replay and before persistence/finalization; partial output is never marked complete.

MySQL 8.4 integration validation uses separate pools and the legacy `VARCHAR(20)` status column. The compatible internal cancellation state is `cancel_requested`; the timestamp field remains `cancellation_requested_at` and public APIs continue reporting `RUNNING` until cancellation completes.

User cancellation is now atomic and resource-scoped: normal users match `created_by`, administrators use an explicit scope, and unauthorized/nonexistent IDs are indistinguishable. Worker acknowledgement remains separately protected by processor identity and lease.

User cancellation is now atomic and resource-scoped: normal users match `created_by`, administrators use an explicit scope, and unauthorized/nonexistent IDs are indistinguishable. Worker acknowledgement remains separately protected by processor identity and lease.

## Current queue

`backtest_runs` is the queue/status table; result families include backtest signals, trades, outcomes, metrics, equity, audit, and calibration data. `src/lib/backtesting/runner/backtestQueue.ts` performs the atomic queued-to-running claim and the scheduler drains once per minute. Next APIs submit/list/status/cancel; the monolith remains the sole processor. Queued cancellation exists; running cancellation is not cooperative. Failures use the existing failed state. Results use production Strategy parity through `@strategy-engine` and historical market data.

Risks: long simulations, partial result persistence, stale running jobs, missing lease/heartbeat identity, ambiguous retries, and simultaneous API/scheduler kicks. No ownership or schema was changed here.

## Required additive claim model

Before activation, verify or add—through a separately reviewed reversible MySQL migration—processor ID, claimed/heartbeat timestamps, attempt/max-attempt counts, lease expiry, cancellation requested, failure category/last error, idempotency key, input version, Strategy implementation version, and worker version. Claims must be compare-and-set or transactional locks; heartbeats extend leases; completion/failure must verify processor ownership; stale recovery must be bounded and observable.

## Contracts and owner flag

Contracts for submit, claim, heartbeat, status/progress, completion, failure, cancellation, and stale recovery are in `packages/contracts/src/backtest-worker.ts`.

Proposed `BACKTEST_PROCESSOR_OWNER=monolith|service|disabled` defaults to `monolith`. Invalid values fail startup configuration. Only the selected owner may be ready and claim. Rollback sets `monolith`, stops the service claim loop, and verifies no live lease before restarting the legacy drain. Required telemetry: owner/processor version, claims, conflicts, queue depth, duration, heartbeat age, retries, cancellation, stale recovery, dead jobs, and readiness.

## Skeleton status

`services/backtest-worker` contains typed configuration, ports, readiness diagnostics, and documentation only. It deliberately has no executable server, queue adapter, Dockerfile, Compose/PM2 entry, database mutation, or claim loop. Even `owner=service` reports not-ready and cannot process jobs. Deployment remains disabled pending schema/claim tests and human approval.
## Authoritative processor ownership

MySQL migration 017 defines the runtime owner and positive monotonic epoch. `BACKTEST_PROCESSOR_OWNER` and optional `BACKTEST_OWNERSHIP_EPOCH` are local intent only. Monolith refreshes authority on every dispatch and claim; the worker refreshes every poll and recovery tick. Both use one structured decision contract. Atomic claim SQL joins the authority singleton, and heartbeat, completion, failure, and cancellation acknowledgement require processor ID/type, lease, run epoch, and current authority epoch.

Old-epoch finalization is strictly rejected. Result artifacts written before a transition may remain diagnostic, but the run cannot be presented as completed. No authority is cached indefinitely.
Verification tooling now treats fixture suitability separately from hash integrity. A fixture can have a valid manifest and still be rejected when it cannot drive the real runner. Persisted parity and two-process reports are machine-readable and default to non-success until actual evidence exists.
