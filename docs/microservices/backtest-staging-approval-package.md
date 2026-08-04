# Backtest Worker staging approval package

This package prepares evidence for review and grants no approval.

## Evidence index

- Migrations: `artifacts/backtest-staging-preflight-report.json`
- Fixture and persisted parity: `artifacts/backtest-parity-report.json`
- Independent processes: `artifacts/backtest-two-process-report.json`
- Rollback: `artifacts/backtest-rollback-report.json`
- Authorization: `artifacts/backtest-authorization-report.json`
- Monitoring: `artifacts/backtest-monitoring-report.json`
- CI reliability: `artifacts/backtest-ci-reliability-report.json`

## Deployment checklist

- [ ] Reviewed commit identified
- [ ] Migrations 016/017 approved for staging
- [ ] Monitoring datasource and dashboard destination approved
- [ ] Alert routing and proposed thresholds approved
- [ ] Production files unchanged
- [ ] Worker concurrency confirmed as one
- [ ] Production worker confirmed disabled

## Operator checklist

- [ ] Named primary and secondary operators
- [ ] Ownership authority and expected epoch recorded
- [ ] Audit-output destination writable
- [ ] Synthetic fixture IDs recorded
- [ ] Emergency contacts and observation channel confirmed

## Canary checklist

- [ ] CI reliability evidence accepted
- [ ] Preflight rerun on reviewed commit
- [ ] Owner moved `monolith -> disabled -> service`
- [ ] Worker enabled only after service ownership is authoritative
- [ ] Synthetic parity run observed
- [ ] Queue, lease, readiness, and ownership dashboards observed
- [ ] Limited staging workload and stop criteria approved

## Rollback checklist

- [ ] Stop new service submissions/claims
- [ ] Move `service -> disabled`
- [ ] Reconcile active leases
- [ ] Allow completion or expiry under policy
- [ ] Recover stale jobs without resetting attempts
- [ ] Stop worker
- [ ] Move `disabled -> monolith`
- [ ] Verify monolith readiness and service non-readiness
- [ ] Reconcile queue and preserve audit evidence

## Soak plan

- Proposed duration: 24 hours after synthetic validation and 24 hours after limited staging workload.
- Observe queue age/depth, duplicate claims, stale epochs, heartbeats, lost leases, recoveries, processing duration, queue wait, restarts, parity, and MySQL utilization.
- Stop on any duplicate claim, unexplained parity mismatch, ownership drift, stale-epoch finalization, or unrecoverable queue state.
- Thresholds and soak duration require explicit operator approval.

## Package disposition

Monitoring validation passed locally. Authoritative repeated Linux CI reliability evidence is missing, so this package is incomplete and must not be approved yet.

