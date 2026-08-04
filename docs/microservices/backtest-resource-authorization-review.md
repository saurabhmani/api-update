# Backtest resource authorization review

Inventory: 14 route files, 18 HTTP methods.

| Method | Route | Operation | Current auth | Ownership check | Admin behavior | Enumeration risk | Required action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET/POST | `/api/backtests` | scoped list/submit | Session | actor-scoped list; submission stores owner | explicit all-list | None | Complete |
| GET/DELETE | `/api/backtests/[id]` | detail/delete | Session | parent scope; transactional scoped delete | explicit, audited | None | Complete |
| POST | `/api/backtests/[id]/cancel` | cancellation | Session | atomic owner scope | explicit | None | Complete |
| GET | `/api/backtests/[id]/trades` | trades | Session + parent | scoped parent before child query | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/signals` | signals | Session + parent | scoped parent before query/count | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/analytics` | analytics/equity | Session + parent | scoped parent before loaders | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/performance` | performance | Session + parent | scoped parent | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/calibration` | calibration | Session + parent | scoped parent | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/audit` | audit | Session + parent | scoped parent | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/dexter` | derived results | Session + parent | scoped parent | explicit, audited | None | Complete |
| GET | `/api/backtests/[id]/export` | download | Session + parent | scoped parent before serialization | explicit, audited | None | Complete |
| GET | `/api/backtests/compare` | compare | Session | every ID scoped | explicit | None | Complete |
| GET/POST | `/api/backtests/process-queue` | internal drain/status | Admin | administrative | admin-only | N/A | Existing control |
| GET/POST | `/api/backtests/seed-data` | maintenance | Admin | maintenance-only | admin-only | N/A | Guard added |

Internal runner, persistence, migration, comparison, and export helpers may retain ID-based functions, but public route regression tests require actor-scoped authorization before invoking them.
