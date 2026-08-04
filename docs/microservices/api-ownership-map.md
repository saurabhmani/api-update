# API ownership map

There are 332 filesystem route handlers and 336 exported HTTP methods. This group map does not replace the method inventory in `api-security-inventory.md`.

| Route group | Current handler | Auth requirement | Candidate owner | Priority | Risk |
|---|---|---|---|---:|---|
| auth/security | Next + auth/session | Public login; authenticated/admin thereafter | Identity (late) | 10 | Critical |
| signals/signal-engine | Next + signal libs | Auth/admin/ops varies; audit required | Signal lifecycle | 7 | Critical |
| strategies/strategy-builder | Next + strategy hub/lab | Auth/admin varies | BFF + Strategy package | 1 | High |
| backtest/backtests | Next + backtesting libs | Auth; processor must be internal | BFF + Backtest Worker | 3 | High |
| portfolio/paper/risk | Next | Authenticated | Portfolio/Risk | 8 | Critical |
| market/market-data | Next | Public/auth varies | Market Data | 6 | High |
| broker/kite/execution | Next | Auth + permission | Execution | 9 | Critical |
| health/metrics/admin/debug | Next | Operational/admin | Platform | 2 | High |
| notifications/reports | Next | Authenticated | Alerting/Reporting | 4-5 | Medium |
| public/v1/corporate | Next | Public by design | BFF | n/a | Medium |
