# Database index optimization

Scope: canonical MySQL runtime only. No PostgreSQL service migration was changed.
The migration performs an `INFORMATION_SCHEMA.STATISTICS` comparison using the
ordered column list before issuing DDL, so an equivalent differently named index
is treated as already covered.

## Proposed indexes

| Table | Index columns | Query using it | Expected benefit | Duplicate-index check | Write overhead | Rollback SQL |
| --- | --- | --- | --- | --- | --- | --- |
| `user_sessions` | `(user_id, expires_at)` | Session listing/count and expiry checks such as `WHERE user_id=? AND expires_at>NOW()` | Narrows one user's live sessions without scanning all rows for that user | Existing `token` unique index handles authentication; existing `user_id` index is only a prefix and cannot apply the expiry range | Small: one additional two-column entry per login/session update | `ALTER TABLE user_sessions DROP INDEX idx_sessions_user_expires;` |
| `portfolio_positions` | `(portfolio_id, added_at)` | `/api/portfolio?view=positions`: `WHERE portfolio_id=? ORDER BY added_at DESC` | Avoids filesort after portfolio ownership resolution | Existing `portfolio_id` index filters but does not provide requested ordering | Small to moderate on position inserts | `ALTER TABLE portfolio_positions DROP INDEX idx_pp_portfolio_added;` |
| `trade_setups` | `(user_id, status, created_at)` | User-owned active setup list ordered by newest/confidence | Restricts the working set to one user's active rows and supplies a useful ordering prefix | Unique `generation_identity` supports idempotency but not user list reads; status-only index is global | Moderate because regeneration updates status/timestamps | `ALTER TABLE trade_setups DROP INDEX idx_ts_user_status_created;` |
| `news` | `(is_published, category_id, published_at)` | News list with optional `category_id`, published filter, and newest-first ordering | Avoids scanning all published news for category pages | Existing `(is_published, published_at)` remains optimal for the no-category query; the new index is not an ordered-column duplicate | Moderate on ingestion/publish operations | `ALTER TABLE news DROP INDEX idx_news_published_category_date;` |
| `paper_orders` | `(account_id, created_at)` | Paper order history: `WHERE account_id=? ORDER BY created_at DESC LIMIT 200` | Avoids filesort for the unfiltered account order book | Existing `(account_id,status)` serves status-filtered reads and `(account_id,idempotency_key)` serves deduplication; neither orders all account rows by creation time | Moderate on every paper order insert | `ALTER TABLE paper_orders DROP INDEX idx_paper_orders_account_created;` |

## Reviewed without adding indexes

- `user_sessions.token` is already unique and supports the primary session lookup.
- `q365_signals` already has `(symbol,status)`, `(status,generated_at)`,
  `batch_id`, classification, final-score, and lifecycle-related indexes. No
  recurring symbol/timeframe predicate was found to justify another composite.
- `q365_confirmed_signal_snapshots` already has `(status,valid_until)`,
  `(symbol,direction,status)`, `source_signal_id`, and `confirmed_at`.
- `strategy_hub_config_history` already has `(strategy_id,version_number)`,
  matching version history and `MAX(version_number)` reads.
- `paper_orders(account_id,idempotency_key)` is already unique.
- Portfolio ownership resolves through indexed `portfolios.user_id` and the
  primary `portfolios.id`.

## EXPLAIN status

A read-only EXPLAIN run was attempted for all five representative queries. The
local Node runtime failed before connecting with `uv_os_get_passwd ENOMEM`, so no
database plan is claimed. The migration is therefore based on inspected query
predicates/order clauses and schema-declared indexes. Run the following after
applying the migration in a staging MySQL environment:

```sql
EXPLAIN SELECT id, token FROM user_sessions
 WHERE user_id=1 AND expires_at>NOW() ORDER BY created_at DESC;
EXPLAIN SELECT * FROM portfolio_positions
 WHERE portfolio_id=1 ORDER BY added_at DESC;
EXPLAIN SELECT id, tradingsymbol FROM trade_setups
 WHERE user_id=1 AND status='active' AND expires_at>NOW()
 ORDER BY confidence DESC, created_at DESC LIMIT 20;
EXPLAIN SELECT id, title FROM news
 WHERE is_published=TRUE AND category_id=1
 ORDER BY published_at DESC LIMIT 20;
EXPLAIN SELECT * FROM paper_orders
 WHERE account_id='audit' ORDER BY created_at DESC LIMIT 200;
```

Expected `key` values are the five index names in the table above. MySQL may
still report `Using filesort` for Trade Setup because confidence precedes
creation time in the response ordering; the index intentionally prioritizes
high-selectivity ownership/status filtering without making a large covering
index.
