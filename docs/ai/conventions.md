# AI Map — Conventions

> Audited 2026-07-17. Code is source of truth.

## Paths & aliases

| Alias | Resolves to |
|---|---|
| `@/*` | `./src/*` |
| `@contracts/*` | `./packages/contracts/src/*` |
| `@eventbus/*` | `./packages/eventbus/src/*` |
| `@rpc/*` | `./packages/rpc/src/*` |

## File placement

| Kind | Location | Notes |
|---|---|---|
| Page | `src/app/<route>/page.tsx` | Prefer `'use client'` for interactive; compose `AppShell` |
| API route | `src/app/api/<cluster>/.../route.ts` | Export `GET`/`POST`/…; prefer `withApiHandler` for new routes |
| Component | `src/components/<area>/` | Colocate `*.module.scss` |
| Hook | `src/hooks/` | React Query for server state (strategies/trust) |
| Service (orchestration) | `src/services/` | Compose lib + DB + providers for routes |
| Domain/engine/infra | `src/lib/<domain>/` | SQL/repos live here, not in routes |
| Provider adapter | `src/providers/adapters/` | Kite / Yahoo / NSE |
| Worker/cron | `src/lib/workers/`, `src/lib/cron/` | Spawned by `server.js` or boot |
| Test | `src/**/*.vitest.ts` or `src/__tests__/` | Vitest include = `*.vitest.ts` |
| Script | `scripts/` | Run via `tsx` / npm scripts |
| Schema DDL | `src/lib/db/migrate*.ts`, `ensureAllSchemas.ts`, `signal-engine/repository/ensureSchemas.ts` | Additive `IF NOT EXISTS` |

## Naming

- Modules: `camelCase.ts`; React components: `PascalCase.tsx`
- Tables: `q365_*` for platform domain; columns `snake_case`
- Instrument key: `NSE_EQ|SYMBOL` (indices `NSE_INDEX|SYMBOL`)
- Cookie: `q200_session` (historical name; do not rename casually)
- Env: `SCREAMING_SNAKE`; provider decisions via `providerFlags.ts` only

## Coding patterns

1. **Routes → services → lib.** Keep SQL out of `route.ts` when a repository exists.
2. **Live prices only via `resolveBatch`** (`marketDataResolver.ts`). Honor market-closed gate and `dataQuality='LOW'` stop contract.
3. **Provider flags:** never branch on raw `process.env.MARKET_DATA_*` in new code — call `providerFlags` helpers.
4. **Session guards** at top of handlers: `requireSession()` / `requireAdmin()` / `requirePermission()`.
5. **Errors:** prefer `src/lib/errors.ts` types; wrap new routes with `withApiHandler` for `{ success, requestId, … }` envelope.
6. **Logging:** `import { logger } from '@/lib/logger'` (custom JSON). Do not introduce winston usage (`winston` is an unused dependency).
7. **Schema changes:** `CREATE TABLE IF NOT EXISTS` + additive `ALTER`; **create columns before indexes** that reference them.
8. **Forms:** controlled React state; no Zod/RHF in dependencies.
9. **Styling:** SCSS modules + `clsx`; no Tailwind.
10. **AI outputs:** pass through `src/services/aiBoundary.ts` `sanitizeAIOutput` before influencing decisions.

## Response envelopes (not uniform)

| Style | When |
|---|---|
| `{ success: true, requestId, ... }` / `{ success: false, requestId, error, code, statusCode }` | `withApiHandler` (55 routes) |
| `{ ok: true/false, ... }` or bare payload / `{ error }` | Ad-hoc majority |

Do not assume a global envelope when consuming or documenting an endpoint — read the route.

## TypeScript

- `strict: false`, `strictNullChecks: false` (`tsconfig.json`)
- `SessionUser.role` is `'user' | 'admin'` while RBAC `Role` also includes `trader` | `analyst` — update both when extending roles

## Git / secrets

- Never commit real `.env` / `.env.local` / `.env.production` secrets
- Template: `.env.example`
- Rotation notes: `docs/security/credential-rotation.md` (if present)
