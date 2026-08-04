# Current-state verification

Verified 2026-08-03 from source and active configuration. Code wins over planning documents.

- PM2 starts `server.js`; Next HTTP defaults to 5000. Instrumentation starts WebSocket streaming on 5001.
- `server.js` supervises `src/lib/workers/scheduler.ts` and triggers manipulation (13:00 UTC) and learning (15:00 UTC) one-shot workers. Development can use `bootInProc.ts`; flags are intended to prevent duplicate ownership.
- MySQL (`src/lib/db.ts`) is authoritative. Redis is an optional cache, lock, session, and tick store. PostgreSQL assets and `services/*` are partial/transitional.
- No durable production broker, binlog CDC consumer, proven production Strangler route, or deployed Backtest service was found.
- Committed VPS topology is Nginx -> PM2 -> `server.js`. Compose is alternate topology. The Next Dockerfile expects standalone output that `next.config.js` does not configure.
- 332 App Router `route.ts` files exist by filesystem walk. All requested baseline paths exist; service scaffolds and Postgres tooling are inactive/partial rather than authoritative.

Current milestone changes no database, API, scheduler, port, runtime process, deployment, or Phase 3 behavior. Rollback is import-path reversal and removal of the new contract/package.
