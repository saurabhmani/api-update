# Table ownership map

Runtime DDL is distributed; these are verified representative families. Complete CRUD extraction is backlog DATA-001.

| Table/family | Current readers | Current writers | Proposed owner | Shared transaction | Transfer stage |
|---|---|---|---|---|---|
| users/sessions/RBAC | auth and APIs | auth/admin | Identity | Session lifecycle | Late |
| `q365_signals` and artifacts | APIs/reports/backtests | signal phases/workers | Signal lifecycle | Phase 3 persistence | Late |
| `backtest_runs` and results | API/worker/reports | queue/runner | Backtest | Claim/status/results | First service; retain MySQL |
| candles/instruments/provider state | signal/backtest/reports | ingestion/schedulers | Market Data | Ingestion/freshness | Later |
| portfolio/positions/trades | portfolio/risk/execution | portfolio/trading | Portfolio | Pre-trade approval | Later |
| strategy config/performance | hub/signal/learning | admin/learning | Strategy governance | Promotion/config | Package only now |
| manipulation/news | signal/reporting | scanners/ingestion | Intelligence | Scan lifecycle | Later |

Policy: one logical owner, no new cross-service writes, MySQL authoritative, and no transfer in this milestone.
