# Backtest cancellation authorization policy

Repository evidence: `backtest_runs.created_by VARCHAR(100) NULL` is the only Backtest owner field; `requireSession()` returns numeric `id` and role `user|admin`; `requireAdmin()` establishes admin as an application-wide privileged role; no dedicated Backtest permission or tenant column exists. Nullable ownership means legacy/internal rows can be ownerless. New API submissions now persist the session user ID.

| Caller | Own queued run | Own running run | Another user's run | Legacy ownerless run | Terminal run |
| --- | ---: | ---: | ---: | ---: | ---: |
| Normal user | Cancel | Request cancellation | Non-enumerating 404 | Non-enumerating 404 | No transition; compatible current status |
| Admin | Cancel | Request cancellation | Allowed and audited | Allowed and audited | No transition |
| Internal service | Does not use public request API | Lease-owned acknowledgement only | Not applicable | Not applicable | Rejected by state/lease guard |

Unauthorized and nonexistent IDs return the same 404 body. Admin scope is explicit and never represented by a null/fake owner. Cancellation does not change attempts or replace a running processor/lease. Partial artifacts are retained diagnostically but cannot be exposed as completed after cancellation wins.
