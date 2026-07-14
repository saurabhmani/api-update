# Secrets Rotation — Quantorus365

**Phase:** 0 (Foundation)  
**Date:** 2026-07-13  
**Status:** All credentials previously present in a committed or shared `.env.local` are treated as **compromised**.

---

## Credentials Rotated (or Must Be Rotated)

| Secret | Where used | Action |
|--------|------------|--------|
| `MYSQL_PASSWORD` | MySQL connection (`src/lib/db`) | Change DB user password; update `.env.local` / production `.env` |
| `REDIS_PASSWORD` | Redis cache bridge | Rotate in Redis ACL; update env |
| `SESSION_SECRET` | Cookie signing (`src/lib/auth`) | Generate new 64-char hex; **invalidates all sessions** |
| `ENCRYPTION_KEY` | AES-256-GCM for stored tokens | Generate new 64-char hex; re-encrypt or purge encrypted rows |
| `INDIANAPI_API_KEY` | Primary market data | Re-issue at IndianAPI dashboard |
| `KITE_API_KEY` / `KITE_API_SECRET` / `KITE_ACCESS_TOKEN` | Broker (if enabled) | Regenerate at [Kite developer console](https://developers.kite.trade/) |
| `RESEND_API_KEY` | OTP email delivery | Rotate in Resend dashboard |
| `GNEWS_API_KEY`, `NEWSDATA_API_KEY`, `NEWSAPI_API_KEY`, `FINNHUB_API_KEY` | News feeds | Rotate per vendor |
| `SEED_*_PASSWORD` | Dev bootstrap only | Remove from production env entirely |

---

## Replacement Process

### 1. Generate new local secrets

```bash
# Session secret (32 bytes → 64 hex chars)
openssl rand -hex 32

# Encryption key (32 bytes for AES-256)
openssl rand -hex 32
```

### 2. Update environment files

1. Copy `.env.example` → `.env.local` (dev) or `.env` (prod).
2. Fill placeholders — **never** copy values from old shared files.
3. Confirm `.env*` is gitignored (`.env.example` is the only tracked env file).

### 3. Rotate upstream services

| Service | Steps |
|---------|-------|
| MySQL | `ALTER USER … IDENTIFIED BY 'new_password';` then update env |
| Redis | `ACL SETUSER default on >newpassword` or provider console |
| IndianAPI | Dashboard → API keys → revoke old, create new |
| Kite | Revoke app keys; regenerate access token via OAuth flow |
| Resend | API keys → create new, delete old |

### 4. Deploy and verify

```bash
npm run typecheck
npm run build
npm run test:signals-gate
```

Restart PM2 / worker processes so they load the new env:

```bash
pm2 restart all
# or individually: scheduler, learning-scheduler, ws-server
```

### 5. Invalidate compromised artifacts

- Force logout all users (session secret change handles this).
- If `ENCRYPTION_KEY` changed, clear `q365_user_sessions` encrypted broker tokens or run the broker re-link flow.
- Audit `git log` for any historical `.env` commits; use `git filter-repo` only if secrets were ever pushed.

---

## Local Setup Instructions

1. Clone the repository.
2. `cp .env.example .env.local`
3. Set `MYSQL_*` to a local MySQL instance with the `quantorus365` schema (`npm run db:migrate-all`).
4. Set `KITE_API_KEY` + `KITE_ACCESS_TOKEN` for the default Kite primary, and keep `INDIANAPI_API_KEY` configured for automatic fallback + unsupported features. Set `INDIANAPI_PRIMARY=true` for immediate IndianAPI recovery, or `MARKET_DATA_PROVIDER=legacy` only for offline DB-only scans.
5. Generate fresh `SESSION_SECRET` and `ENCRYPTION_KEY` (see above).
6. `npm install && npm run dev`

**Never** commit `.env.local`. The template at `.env.example` contains placeholders only.

---

## Repository Hygiene (Phase 0)

- `.env*` (except `.env.example`) — gitignored
- `logs/`, `*.log`, `.next/`, `dist/`, `coverage/` — gitignored
- `.cursor/`, `.claude/`, `.vscode/` — gitignored
- Accidental `.claude/` artifacts removed from tracking in Phase 0
