# Backtest queue preflight runbook

The preflight is read-only and emits one JSON object plus a concise human-readable result. Exit `0` means no blocker; exit `2` means a blocker; exit `1` means execution failure.

Blockers are invalid statuses, running rows without claim/lease timestamps, queued/running rows at their attempt ceiling, and cancellation-state inconsistencies. Warnings are duplicate non-null idempotency values, terminal rows without completion timestamps, and stale running leases. Warnings require review but do not silently alter data. Output includes database name, migration version, execution timestamp, and every category count. Never include `config_json` in the report.
# Operational prerequisites

Before treating preflight as approval evidence, attach `backtest-monitoring-report.json` and a completed `backtest-ci-reliability-report.json`. A locally passing preflight does not replace repeated CI reliability or operator approval.
