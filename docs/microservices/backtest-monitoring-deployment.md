# Backtest Worker staging monitoring deployment

The existing dashboard and alert definitions were loaded unchanged into a disposable staging-compatible runtime on 2026-08-04:

- Prometheus 3.5.0 at the internal validation endpoint
- Grafana 12.1.0 with a provisioned Prometheus datasource
- Pushgateway 1.11.1 for deterministic validation samples only

This was not a production deployment. The runtime used loopback-only host ports and was removed after verification.

## Locations

- Dashboard: `deploy/staging/observability/backtest-worker-dashboard.json`
- Alerts: `deploy/staging/observability/backtest-worker-alerts.yml`
- Validation Compose: `deploy/staging/observability/validation/docker-compose.yml`
- Prometheus configuration: `deploy/staging/observability/validation/prometheus.yml`
- Alert tests: `deploy/staging/observability/validation/backtest-worker-alert-tests.yml`
- Machine evidence: `artifacts/backtest-monitoring-report.json`

Prometheus loaded all eight rules, its validation target was healthy, and Grafana provisioned the existing Backtest dashboard. Promtool verified every rule both fires and returns to normal without changing production thresholds. Thresholds remain proposed until operators approve them.

## Operational response

For queue age, readiness, heartbeat, stale recovery, duplicate claim, stale epoch, pool saturation, or parity alerts:

1. Set ownership to `disabled` before a processor handoff.
2. Inspect authority owner/epoch and active leases.
3. Do not reset attempts or delete queue rows.
4. Allow active work to complete or leases to expire under the documented policy.
5. Recover stale work through the supported queue recovery path.
6. Restore monolith ownership through `disabled` if service safety is uncertain.
7. Preserve the ownership, parity, rollback, and monitoring artifacts.

Rollback events are evidenced by the ownership audit and `backtest-rollback-report.json`; the worker is not granted an administrative rollback endpoint.

