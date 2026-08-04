# Extraction scorecard

Scores 1 (poor/high coupling) to 5 (favorable/low coupling); security risk 1 (low) to 5 (high).

| Candidate | Business cohesion | DB coupling | Runtime coupling | Transaction complexity | Independent scaling | Reversibility | Security risk | Recommended order |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Strategy package | 5 | 5 | 3 | 5 | 2 | 5 | 2 | 1 |
| Risk facade | 4 | 2 | 2 | 1 | 2 | 4 | 5 | 2 |
| Backtest worker | 5 | 3 | 4 | 3 | 5 | 4 | 3 | 3 |
| Alert delivery | 4 | 4 | 4 | 4 | 4 | 4 | 3 | 4 |
| Reporting | 4 | 3 | 4 | 4 | 4 | 4 | 2 | 5 |
| Market ingestion | 4 | 2 | 2 | 3 | 5 | 3 | 3 | 6 |
| Signal Engine | 5 | 1 | 1 | 1 | 4 | 2 | 5 | 7 |
| Portfolio | 5 | 1 | 2 | 1 | 3 | 2 | 5 | 8 |
| Broker execution | 5 | 3 | 2 | 1 | 3 | 1 | 5 | 9 |
| Identity | 5 | 1 | 1 | 2 | 3 | 1 | 5 | 10 |

Evidence: `runStrategies.ts` is deterministic but inline; backtesting already has a queue and production-parity adapter; Signal/Phase 3 spans risk, portfolio, persistence, and schedules; Identity protects most private routes; execution has irreversible broker effects.
