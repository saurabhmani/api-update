# Transaction inventory

| Transaction | Objects | Invariant | Constraint |
|---|---|---|---|
| Session create/revoke | users, sessions, cache | `q200_session` validity | Preserve BFF semantics |
| Phase 3 approval/persist | candidates, risk/portfolio inputs, signal artifacts | Rejection authoritative; risk mandatory | Do not split before parity proof |
| Backtest claim/process | runs/results | One claimant; deterministic replay/cancellation | CAS/lock, identity, attempts, recovery |
| Portfolio/pre-trade | positions, exposure, order state | No risk bypass | Fail closed |
| Scheduled scan | locks, signals, snapshots | One owner/execution | Flag + durable lock |
| Strategy promotion/config | versions/config/audit | Reproducible version | Stable contract/version |

No transaction changes in this milestone.
