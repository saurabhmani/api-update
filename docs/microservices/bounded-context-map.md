# Bounded-context map

| Context | Evidence | Direction |
|---|---|---|
| Strategy evaluation | `signal-engine/strategies`, `strategy-engine`, `scoring`, `trade-plan` | Stable in-process package first |
| Signal lifecycle | Signal pipelines, persistence, maturity | Keep phases cohesive; extract late |
| Risk/pre-trade | `src/lib/risk` plus Phase 3 risk/portfolio-fit/execution | Facade first; fail closed |
| Backtesting | `src/lib/backtesting`, MySQL queue, scheduler drain | First deployable candidate after claim/ownership controls |
| Market data | `src/lib/marketData`, `src/providers`, Redis | Contract/facade before extraction |
| Portfolio | Portfolio/paper trading/risk transactions | Later |
| Identity | Auth/session/RBAC required cross-cutting | Late |
| Broker execution | External side effects and risk gates | Last/high risk |
| Alerting/reporting | Reliability/reporting modules | Evaluate after backtest |

The safest package boundary is Strategy Engine. Backtest Worker is the safest service candidate only after idempotent claims, explicit scheduler ownership, cancellation/stale recovery, processor identity, attempt counts, and parity tests exist.
