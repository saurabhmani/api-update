# Dependency map

- Next/API -> Signal orchestration -> `@strategy-engine` -> legacy in-process evaluator/scoring/trade-plan implementation.
- Signal Phase 3 -> Risk + portfolio fit + execution readiness -> MySQL.
- Backtest APIs -> MySQL queue <- scheduler drain -> runner -> `@strategy-engine`.
- Market consumers -> resolver/provider policy -> providers + Redis.
- `server.js` -> scheduler child -> scans, maturity, snapshots, alerts, backtest drain.

Code outside `src/lib/signal-engine` must use `@strategy-engine`. Temporary shared MySQL access remains documented debt until an ownership transfer is approved.
