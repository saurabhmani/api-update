# Secrets Rotation — Quantorus365

**Phase:** 0 (Foundation)  
**Date:** 2026-07-13  
**Status:** All credentials previously present in a committed or shared `.env.local` are treated as **compromised**.

Primary manual checklist for upstream services: [credential-rotation.md](./credential-rotation.md).

---

## Credentials Rotated (or Must Be Rotated)

| Secret | Where used | Action |
|--------|------------|--------|
| `MYSQL_PASSWORD` | MySQL connection (`src/lib/db`) | Change DB user password; update `.env.local` / production `.env` |
| `REDIS_PASSWORD` | Redis cache bridge | Rotate in Redis ACL; update env |
| `SESSION_SECRET` | Cookie signing (`src/lib/auth`) | Generate new 64-char hex; **invalidates all sessions** |
| `ENCRYPTION_KEY` | AES-256-GCM for stored tokens | Generate new 64-char hex; re-encrypt or purge encrypted rows |
| `KITE_API_KEY` / `KITE_API_SECRET` / `KITE_ACCESS_TOKEN` | Primary market data (Kite) | Regenerate at [Kite developer console](https://developers.kite.trade/) |
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
3. Confirm `.env*` is gitignored except tracked `.env.example`.
4. Complete manual upstream rotations listed in [credential-rotation.md](./credential-rotation.md).

### 3. Rotate upstream services

Follow [credential-rotation.md](./credential-rotation.md). Do not invent credentials in source control.

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
3. Fill placeholders; complete [credential-rotation.md](./credential-rotation.md) for upstream services.
4. Set `MYSQL_*` to a local MySQL instance with the `quantorus365` schema (`npm run db:migrate-all`).
5. Set Kite credentials for the default primary (`MARKET_DATA_PROVIDER=kite`). Yahoo/NSE are fallbacks.
6. Ensure `SESSION_SECRET` and `ENCRYPTION_KEY` are fresh 64-char hex (or regenerate as above).
7. `npm install && npm run dev`

**Never** commit `.env.local`. The template at `.env.example` contains placeholders only.

---

## Repository Hygiene (Phase 0)

- `.env*` gitignored except tracked `.env.example`
- `logs/`, `*.log`, `.next/`, `dist/`, `coverage/` — gitignored
- `.cursor/`, `.claude/`, `.vscode/` — gitignored
- Accidental `.claude/` artifacts removed from tracking in Phase 0
