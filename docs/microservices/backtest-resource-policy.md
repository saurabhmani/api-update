# Backtest resource authorization policy

Approved policy: private by default. Evidence and authority are `backtest_runs.created_by`, authenticated session user IDs, the established `admin` role, and the absence of any team/tenant/public-sharing model.

| Operation | Normal user own run | Normal user other run | Admin | Ownerless legacy run | Internal worker |
| --- | ---: | ---: | ---: | ---: | ---: |
| List | Yes | Hidden | All | Admin only | No public list |
| Read summary/config/progress | Yes | 404 | All, audited | Admin only | Queue fields only |
| Read trades/signals/analytics/performance/calibration/audit/Dexter | Yes | 404 | All, audited | Admin only | No public method |
| Export/compare | Own IDs only | 404 | All, audited | Admin only | No |
| Delete | Own terminal only | 404 | Terminal, explicit and audited | Admin only | No |
| Cancel | Own only | 404 | Explicit admin | Admin only | Lease-scoped acknowledgement |

Queued, running, and `cancel_requested` rows cannot be deleted. A queued run must use cancellation. Allowed deletion states are `completed`, `failed`, `dead`, `cancelled`, `partial_success`, and legacy `success`. Hard deletion is retained, but parent authorization, state validation, child deletion, and parent deletion run in one transaction.

Normal-user cross-owner, hidden ownerless, and nonexistent resources use HTTP 404 with `{ "ok": false, "error": "Backtest not found" }`. Ownerless rows are never reassigned.
