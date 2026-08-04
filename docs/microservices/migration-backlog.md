# Migration backlog

Backtest lease claiming, worker runtime, cooperative cancellation, stale recovery, and owner guards are implemented but not production-enabled. A staging canary remains approval-gated.

Live MySQL queue integration and preflight fixtures are implemented. Persisted deterministic business-result parity and an executed staging handoff remain blocking backlog items.

Backtest cancellation now enforces atomic owner/admin scope. Define and remediate list/detail/delete resource visibility before staging.

Private-by-default list, detail, child, export, compare, cancellation, and transactional terminal deletion scope is implemented; persisted parity remains next.

Backtest cancellation now enforces atomic owner/admin scope. Define and remediate list/detail/delete resource visibility before staging.

| ID | Title | Scope / dependencies | Risk | Complexity | Acceptance / validation | Rollback |
|---|---|---|---|---|---|---|
| STR-001 | Strategy boundary | Contract, facade, callers; none | Low | M | Typecheck + contract/parity tests; no external direct imports | Revert imports/remove facade |
| SEC-001 | Route security inventory | Classify all 332 handlers/336 methods; STR-001 independent | High | L | Guard/source tests; intended public APIs documented | Revert guard changes individually |
| TEST-001 | Critical characterization | Auth, Phase 3, risk, provider fallback, backtest, schedulers | Medium | L | Golden masters stable in CI | Test-only revert |
| OBS-001 | Shared request/worker telemetry | Logging/IDs/metrics/shutdown | Medium | L | API + worker operational tests | Disable wrapper adoption |
| FLAG-001 | Typed flags | Legacy/remote/shadow/canary/owner/write/rollback | Medium | M | Defaults prove legacy behavior | Remove abstraction |
| RISK-001 | Risk facade | Preserve distinct Phase 3 calculations; TEST-001 | Critical | L | Phase 3 golden masters identical | Restore direct calls |
| MKT-001 | Market-data facade | Preserve provider order/fallback; TEST-001 | High | L | Fallback tests identical | Restore imports |
| DATA-001 | Full table CRUD map | Static SQL + runtime schema inventory | Medium | L | Every table has logical owner/readers/writers | Docs-only revert |
| BT-001 | Backtest claim hardening | Processor identity, attempts, stale recovery | High | L | Concurrency/cancel/retry tests | Leave columns unused; legacy claim |
| BT-002 | Scheduler ownership flag | FLAG-001, BT-001 | High | M | Exactly one drain owner in tests/metrics | Enable monolith owner |
| BT-003 | Backtest service skeleton | BT-001/2, observability | Medium | L | Independent health/readiness/shutdown/contract tests | Do not start service |
| BT-004 | Strangler adapter | BT-003, typed client | High | L | Legacy/shadow/canary/remote tests; no ambiguous-write fallback | Legacy mode |
| EVT-001 | Backtest lifecycle event decision | Actual durable use case | Medium | M | Approved ADR and broker comparison | Keep MySQL polling |
| SIG-001 | Signal extraction readiness | Strategy/Risk/Market stable, Phase 3 parity | Critical | XL | All ADR-012 criteria met | Remain monolith |
| SEC-002 | Resolve ambiguous route intent | Owner review for Unknown/public health/debug/MFA routes; SEC-001 | High | L | Every method has approved classification; focused auth tests | Revert guards individually |
| BT-005 | Additive lease migration proposal | DATA-001, BT-001 approval | High | M | Reviewed MySQL DDL; backward compatible; no activation | Drop only new unused columns before use |
| BT-006 | Queue adapter and concurrency suite | BT-005, owner flag implementation | High | L | CAS/lease/cancel/retry/stale recovery tests | Keep adapter unused |

Validation commands are `npm.cmd run typecheck`, `npm.cmd run lint`, focused `npx.cmd vitest run ...`, `npm.cmd run test:signals-gate`, and `npm.cmd run build` as applicable. No deployment work begins before human review of STR-001.

## 2026-08-03 milestone update

- SEC-001: inventory generated for 332 filesystem handlers/336 methods; eight unambiguous critical mutation gaps remediated. Remaining automated inventory: zero critical, 19 high, 37 Unknown; owner review remains SEC-002.
- TEST-001: added facade parity, security guard, scheduler-default, atomic-claim, and worker-owner characterization; broader existing Phase 3/auth/backtest suites remain validation gates.
- RISK-001: in-process facade implemented; Phase 3 uses it for risk, portfolio fit, and execution readiness without semantic changes.
- MKT-001: in-process facade implemented; selected quote consumers migrated without provider-policy changes.
- BT-001/2/3: design/contracts and inert skeleton prepared. No schema hardening, scheduler-owner change, or service activation occurred; BT-005/6 remain prerequisites.
Staging preparation now includes a versioned fixture, persisted-table comparator, proposed ownership migration 017, monotonic safe transitions, and epoch-scoped service acknowledgements. Actual independent OS-process parity and rollback execution remain blockers.
Authoritative ownership-epoch enforcement is now shared by monolith and worker queue paths. Remaining evidence is independent OS-process proof; staging parity, integrated operational preflight execution, rollback rehearsal, dashboards, thresholds, and approvals remain open.
Verification update: the deterministic fixture is hash-consistent but has insufficient candle depth for the real engine. Persisted parity is not executed. A real two-process harness and staging dashboard/alert definitions exist, but local execution is blocked by the Windows TypeScript runtime failure and crash recovery remains incomplete.
# Backtest pre-canary evidence update (2026-08-04)

- Completed: deterministic synthetic fixture v2 generator, canonical generation check, hashes, 280 bars per symbol, static runner gate, accepted/rejected production pipeline test.
- Blocked: disposable full-schema setup stalls before migration 017/candle load; real monolith and worker runs were not produced.
- Pending: persisted parity, independent ownership scenarios, crash recovery, rollback rehearsal, live endpoint preflight, observability firing verification, and approvals.
- Completed locally: migrations through 017, fixture load, real monolith and worker runs, zero-mismatch parity, independent-process ownership, SIGKILL recovery, rollback, and live-endpoint preflight.
- Remaining: deployed observability/alert firing proof, repeated Linux CI reliability statistics, and staging approvals.
- Completed locally: migrations through 017, fixture load, real monolith and worker runs, zero-mismatch parity, independent-process ownership, SIGKILL recovery, rollback, and live-endpoint preflight.
- Remaining: deployed observability/alert firing proof, repeated Linux CI reliability statistics, and staging approvals.
