# Risk register

Backtest split-brain is mitigated by one validated ownership mode and conditional MySQL claims; handoffs pass through `disabled`. Lost workers are handled by leases and idempotent recovery. Replay-unsafe failures must be explicitly non-retryable.

Configuration drift remains a staging blocker unless deployment preflight observes the same ownership epoch after both processes restart. Full persisted-result parity remains unproven until approved deterministic market fixtures are available.

Cancellation cross-user mutation is remediated. Adjacent Backtest list/detail/delete routes remain authenticated but not resource-scoped; DELETE is a critical staging blocker pending policy approval.

Backtest resource enumeration and cross-user deletion are remediated by centralized actor scope. Residual risk is regression in new routes, guarded by the Backtest route source contract and live repository tests.

Cancellation cross-user mutation is remediated. Adjacent Backtest list/detail/delete routes remain authenticated but not resource-scoped; DELETE is a critical staging blocker pending policy approval.

| Risk | Evidence | Mitigation / stop condition |
|---|---|---|
| Phase 3 semantics drift | Strategy, risk, portfolio, execution intertwined | Golden masters; stop on any rejection change |
| Duplicate schedules | server child, in-proc boot, overlapping manipulation evidence | Explicit owner flag + durable lock before move |
| Ambiguous duplicate writes | Future remote timeout | Idempotency/status reconciliation; never hidden fallback |
| Shared MySQL ownership | Most modules query common tables | Logical owner map; no new cross-service writes |
| Session bypass | Proxy checks cookie presence; route guards are explicit | Route-by-route audit before routing |
| Backtest duplicate processing | API/scheduler queue paths | Atomic claims, identity, attempts, stale recovery |
| Provider behavior drift | Multiple fallback adapters | Facade with characterization tests |
| Compose mistaken as production | Compose lists many PG services | PM2/VPS remains source of truth |
| Docker build mismatch | standalone image expectation not configured | Verify/fix separately; no current deployment change |
| Partial Postgres mistaken as authority | migrations/services/dual-write exist | MySQL stays authoritative pending approved cutover |

Genuine approval gates: production topology/cutover, data ownership transfer, database-engine cutover, broker introduction, destructive schema changes, breaking APIs/IDs, Phase 3 or risk-policy changes, and legacy-path removal.
Ownership drift is reduced by proposed migration 017 and epoch-scoped service operations, but monolith runtime epoch integration and independent two-process evidence remain open. Persisted comparator tests are green; actual fixture persistence parity is not executed.
Queue claim/readiness drift is mitigated by per-attempt authority refresh and atomic authority-joined claims. Old-epoch lifecycle acknowledgement is rejected. Residual risk: independent-process behavior and staging operations have not been exercised; migration 017 is not approved for production.
Fixture false-confidence risk is now fail-closed: manifest integrity and real-runner suitability are separate gates. The current fixture is unsuitable, so parity cannot be promoted. Independent-process execution also remains unproven on the current host.
# 2026-08-04 evidence risks

- **BT-EVIDENCE-SCHEMA-SETUP (open, canary blocker):** the full disposable runner schema initializer stalls before ownership migration and fixture load. Mitigation: instrument the initializer by phase, close its shared DB pool explicitly, bulk-load fixtures, and rerun on Linux CI.
- **BT-WINDOWS-NODE-STARTUP (open, non-application):** Windows `tsx` fails before user code with `uv_os_get_passwd ENOMEM`. Linux CI/Docker is the authoritative process environment.
- **BT-EVIDENCE-SCHEMA-SETUP:** mitigated locally. Root cause was duplicate lease-column creation before migration 016; pre-016 baseline mode and bounded pool shutdown now pass in MySQL 8.4.
- **BT-CI-RELIABILITY (open, canary blocker):** only one successful local Linux process run exists; consecutive CI runs and flake-rate measurement remain outstanding.
- **BT-OBS-FIRING (open, canary blocker):** dashboard/alert files exist, but deployed rule loading and alert-firing evidence remain outstanding.
- **BT-EVIDENCE-SCHEMA-SETUP:** mitigated locally. Root cause was duplicate lease-column creation before migration 016; pre-016 baseline mode and bounded pool shutdown now pass in MySQL 8.4.
- **BT-CI-RELIABILITY (open, canary blocker):** only one successful local Linux process run exists; consecutive CI runs and flake-rate measurement remain outstanding.
- **BT-OBS-FIRING (open, canary blocker):** dashboard/alert files exist, but deployed rule loading and alert-firing evidence remain outstanding.
