# Backtest Worker

An internal MySQL queue consumer that reuses the monolith Backtest engine. It is safe-off by default.

Start locally only after applying the additive MySQL migration and stopping monolith queue ownership:

```text
BACKTEST_PROCESSOR_OWNER=service
BACKTEST_WORKER_ENABLED=true
npm --prefix services/backtest-worker start
```

The internal HTTP listener binds to `127.0.0.1:4800` by default and exposes `/health`, `/ready`, and `/metrics`. It is not a browser API. Restore `BACKTEST_PROCESSOR_OWNER=monolith` only after stopping the service and recovering expired leases as described in the rollout runbook.
