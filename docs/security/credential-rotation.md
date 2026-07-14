# Credential Rotation — Phase 0 Manual Upstream Steps

**Phase:** 0 (Foundation)  
**Date:** 2026-07-14  
**Status:** All credentials previously present in `.env.local` are treated as **compromised**.

This document lists **upstream / service credentials that must be rotated manually**. Local cryptographic secrets (`SESSION_SECRET`, `ENCRYPTION_KEY`) were regenerated automatically during Phase 0 and do **not** appear here as pending.

Phase 0 acceptance does **not** block on completion of these manual steps. Track them as operational work before production use of live providers.

Related: [secrets-rotation.md](./secrets-rotation.md)

---

## Automatically completed in Phase 0

| Secret | Action taken |
|--------|----------------|
| `SESSION_SECRET` | Regenerated via `openssl rand -hex 32` in `.env.local` — invalidates existing sessions |
| `ENCRYPTION_KEY` | Regenerated via `openssl rand -hex 32` in `.env.local` — re-link or purge encrypted broker tokens |
| `KITE_API_KEY` / `KITE_API_SECRET` / `KITE_ACCESS_TOKEN` | Cleared to blank placeholders in `.env.local` (not invented) |
| `REDIS_PASSWORD` | Cleared to blank placeholder in `.env.local` |
| `MYSQL_PASSWORD` | Cleared to blank placeholder in `.env.local` |
| `SEED_*_PASSWORD` | Cleared to blank placeholders in `.env.local` |

Template with placeholders only: repository `.env.example` (tracked). Never commit `.env.local`.

---

## Manual upstream rotations (required for production)

| Credential | Where used | Manual action | Done? |
|------------|------------|---------------|-------|
| `MYSQL_PASSWORD` (and prefer rotate DB user) | `src/lib/db`, migrations, workers | On MySQL: `ALTER USER … IDENTIFIED BY '<new>';` then set `MYSQL_PASSWORD` in `.env.local` / production `.env` | ☑ local (2026-07-14) — production VPS still ☐ |
| `REDIS_PASSWORD` | Redis cache / tick bridge (`REDIS_*`) | Rotate via Redis ACL or provider console; set `REDIS_PASSWORD` or keep `REDIS_DISABLED=1` until ready | ☐ |
| `KITE_API_KEY` | Zerodha Kite Connect | Revoke/regenerate app key at [developers.kite.trade](https://developers.kite.trade/); set in env | ☐ |
| `KITE_API_SECRET` | Kite session exchange | Regenerate with app; never log or commit | ☐ |
| `KITE_ACCESS_TOKEN` | Daily Kite session | Complete official login/token flow; store only in secret store / env | ☐ |
| `RESEND_API_KEY` | OTP / auth email | Create new key in Resend; delete old; set `RESEND_API_KEY` | ☐ |
| `AUTH_EMAIL_FROM` | From-address for Resend | Confirm domain/sender after Resend rotation | ☐ |
| `GNEWS_API_KEY` | News intelligence (optional) | Rotate in GNews dashboard if previously issued | ☐ |
| `NEWSDATA_API_KEY` | News intelligence (optional) | Rotate in NewsData dashboard if previously issued | ☐ |
| `NEWSAPI_API_KEY` | News intelligence (optional) | Rotate in NewsAPI dashboard if previously issued | ☐ |
| `FINNHUB_API_KEY` | News / market optional | Rotate in Finnhub dashboard if previously issued | ☐ |
| `SEED_ADMIN_PASSWORD` / `SEED_JOHN_PASSWORD` / `SEED_PRIYA_PASSWORD` | Dev bootstrap only | Do **not** set in production. For local seed only, use fresh unique passwords never reused from the compromised set | ☐ |

---

## Discovered / related secrets (verify none linger)

| Item | Notes |
|------|--------|
| Commented historical MySQL password in old env copies | Treat as compromised; change DB password even if comment-only |
| Any `.env`, `.env.production`, VPS `/var/www/.../.env` copies | Rotate the same set on every deployed host |
| Browser cookies / sessions | Invalidated by new `SESSION_SECRET`; force re-login |
| Encrypted rows using old `ENCRYPTION_KEY` | Purge or re-encrypt; users may need to re-link brokers |

Repository hygiene: `.gitignore` ignores `.env*` except `.env.example`. Confirm with `git check-ignore -v .env.local` and `git ls-files .env.example`.

---

## Operator checklist (before live Product A on Kite)

1. Rotate MySQL and update `MYSQL_*` on every environment.  
2. Rotate Redis (or keep Redis disabled intentionally).  
3. Issue new Kite API key/secret; obtain fresh access token; set env.  
4. Rotate Resend + optional news keys if they were ever issued.  
5. Restart Next.js / PM2 workers so they load the new env.  
6. Verify `npm run typecheck` and a smoke hit to market + signals health after Kite credentials are set.
