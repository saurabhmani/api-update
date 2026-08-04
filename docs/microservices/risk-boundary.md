# Risk boundary

The Risk facade is in-process and delegates to existing implementations without changing thresholds, ordering, persistence, or exceptions.

| Capability | Current implementation | Callers | Data dependencies | Invariant | Facade operation |
|---|---|---|---|---|---|
| Phase 3 risk | `signal-engine/risk/phase3Risk.ts` | Phase 3 pipeline | Candidate/features/config | Mandatory hard gate | `evaluateSignalRisk` |
| Rejection gates | `core/runRejectionEngine.ts` | Phase 3 | Candidate/risk/quality | Phase 3 authoritative | Remains orchestration-internal |
| Portfolio fit | `portfolio-fit/evaluatePortfolioFit.ts` | Phase 3 | Portfolio snapshot | Rejection remains effective | `evaluatePortfolioFit` |
| Pre-trade readiness | `execution/executionReadiness.ts` | Phase 3 | Risk/portfolio/trade plan | Cannot bypass rejection | `evaluatePreTrade` |
| Stress | `risk/stressTestEngine.ts` | Risk tests/consumers | Scenario inputs | Existing floors preserved | `runStressEvaluation` |
| Exposure/correlation/direction | `portfolio-fit/portfolioRiskEngine.ts` | Portfolio/risk | Positions/limits | Independent hard gates | exposure/risk operations |
| Concentration/drawdown/summary | `portfolio/risk/riskEngine.ts` | Portfolio analytics | Positions/returns/equity | Analytics semantics preserved | concentration/summary operations |
| Manipulation input | manipulation risk envelope consumed in signal pipeline | Signals/Phase 3 | snapshots/events | Penalty cannot become approval | Kept outside facade until contract stabilizes |

Duplicate portfolio-risk implementations exist in `signal-engine/portfolio-fit`, `signal-engine/portfolio`, `portfolio/risk`, Strategy Hub, paper trading, and execution. They are not consolidated because they represent different scopes and thresholds.

Selected Phase 3 calls now enter through `@risk-engine`; rejection orchestration and position sizing remain internal exceptions. The boundary test prohibits new direct imports of selected facade-owned modules outside implementation and tests.
