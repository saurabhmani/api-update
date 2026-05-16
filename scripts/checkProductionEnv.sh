#!/usr/bin/env bash
# scripts/checkProductionEnv.sh
#
# Production-readiness audit. Reads /var/www/api-update/.env.local
# (or path from $ENV_FILE), checks every important variable, and
# reports problems without printing secret values.
#
# Usage on the VPS:
#   bash /var/www/api-update/scripts/checkProductionEnv.sh
#   ENV_FILE=/path/to/other.env  bash scripts/checkProductionEnv.sh

set -uo pipefail

ENV_FILE="${ENV_FILE:-./.env.local}"
if [ ! -f "$ENV_FILE" ]; then
  echo "✗ FATAL  $ENV_FILE not found"
  echo "  Copy the template:  cp .env.production.example .env.local"
  exit 2
fi

echo
echo "Production-readiness audit — $ENV_FILE"
echo "================================================================"

# ── Parse env file into key=value (ignoring comments/blanks) ──────
declare -A E
while IFS='=' read -r key val; do
  [[ "$key" =~ ^[[:space:]]*# ]] && continue   # skip comments
  [[ -z "$key" ]] && continue
  key="${key// /}"
  # Strip trailing inline comments and surrounding whitespace
  val="${val%% #*}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  # Strip surrounding quotes
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  E["$key"]="$val"
done < <(grep -v '^[[:space:]]*$' "$ENV_FILE" | grep -v '^[[:space:]]*#')

PASS=0; WARN=0; FAIL=0
ok()      { printf '  ✓ %s\n' "$1"; PASS=$((PASS+1)); }
warn()    { printf '  ⚠ %s\n' "$1"; WARN=$((WARN+1)); }
fail()    { printf '  ✗ %s\n' "$1"; FAIL=$((FAIL+1)); }

# Helper: numeric range check
num() { local n="$1" lo="$2" hi="$3"; [ -z "$n" ] && echo 'unset' && return; if [[ ! "$n" =~ ^[0-9]+$ ]]; then echo 'non-numeric'; return; fi; if [ "$n" -lt "$lo" ]; then echo 'too-low'; return; fi; if [ "$n" -gt "$hi" ]; then echo 'too-high'; return; fi; echo 'ok'; }

# ── 1. Runtime mode ───────────────────────────────────────────────
echo
echo '[1] Runtime mode'
case "${E[NODE_ENV]:-}" in
  production) ok 'NODE_ENV=production' ;;
  development) fail 'NODE_ENV=development on prod is wrong — Next.js runs in dev mode (slower, more memory)' ;;
  '') warn 'NODE_ENV unset — Next defaults to development. Set NODE_ENV=production' ;;
  *) warn "NODE_ENV=${E[NODE_ENV]} is unusual; expected 'production'" ;;
esac

# ── 2. Database ───────────────────────────────────────────────────
echo
echo '[2] Database'
[ -n "${E[MYSQL_HOST]:-}" ] && ok "MYSQL_HOST set (=${E[MYSQL_HOST]})" || fail 'MYSQL_HOST not set'
[ -n "${E[MYSQL_USER]:-}" ] && ok 'MYSQL_USER set' || fail 'MYSQL_USER not set'
[ -n "${E[MYSQL_PASSWORD]:-}" ] && ok 'MYSQL_PASSWORD set' || fail 'MYSQL_PASSWORD not set'
[ -n "${E[MYSQL_DATABASE]:-}" ] && ok "MYSQL_DATABASE set (=${E[MYSQL_DATABASE]})" || fail 'MYSQL_DATABASE not set'

POOL="${E[MYSQL_POOL_LIMIT]:-}"
case "$(num "$POOL" 5 100)" in
  ok)        ok "MYSQL_POOL_LIMIT=$POOL" ;;
  unset)     warn 'MYSQL_POOL_LIMIT unset — uses default; consider 25 for prod' ;;
  too-low)   fail "MYSQL_POOL_LIMIT=$POOL too low — connection timeouts under load" ;;
  too-high)  warn "MYSQL_POOL_LIMIT=$POOL high — risks MySQL connection limit" ;;
  *)         fail "MYSQL_POOL_LIMIT=$POOL non-numeric" ;;
esac

# ── 3. In-process scheduler ───────────────────────────────────────
echo
echo '[3] In-process scheduler — CRITICAL FOR PROD CPU LOAD'
SCH="${E[Q365_INPROC_SCHEDULER]:-}"
REGEN="${E[Q365_INPROC_REGEN]:-}"
X247="${E[Q365_REGEN_24X7]:-}"

if [ "$SCH" = '0' ] && [ "$REGEN" = '0' ]; then
  warn 'BOTH scheduler AND regen disabled in-process. Make sure a SEPARATE worker (PM2 scheduler.ts) is running, otherwise NO new signals will be produced.'
elif [ "$SCH" = '0' ]; then
  ok 'Q365_INPROC_SCHEDULER=0 — scheduler disabled in-process (assumes external worker)'
elif [ "$REGEN" = '0' ]; then
  ok 'Q365_INPROC_REGEN=0 — heavy 10-min regen disabled; lighter crons still run in-process'
else
  fail 'Both Q365_INPROC_SCHEDULER and Q365_INPROC_REGEN unset/=1 — heavy regen runs every 10 min on the Next.js process. Sets Q365_INPROC_REGEN=0 for prod load.'
fi
if [ "$X247" = '1' ]; then
  fail 'Q365_REGEN_24X7=1 on prod — engine ignores market-hours gate. Burns CPU 24/7. Unset or set to 0.'
else
  ok 'Q365_REGEN_24X7 not enabled (correct for prod)'
fi

# ── 4. SWR cache (live API responsiveness) ────────────────────────
echo
echo '[4] /api/signals SWR cache'
SWR="${E[SIGNALS_SWR_FRESH_MS]:-}"
case "$(num "$SWR" 30000 600000)" in
  ok)
    if [ "$SWR" -lt 60000 ]; then
      warn "SIGNALS_SWR_FRESH_MS=$SWR (~$((SWR/1000))s). Low cache window = MySQL pressure on prod. Recommend ≥120000 (2 min)."
    else
      ok "SIGNALS_SWR_FRESH_MS=$SWR (~$((SWR/1000))s)"
    fi
    ;;
  unset) warn 'SIGNALS_SWR_FRESH_MS unset — defaults to 30s. Recommend SIGNALS_SWR_FRESH_MS=300000 (5 min) on prod.' ;;
  too-low) fail "SIGNALS_SWR_FRESH_MS=$SWR too short — MySQL slammed" ;;
  too-high) warn "SIGNALS_SWR_FRESH_MS=$SWR very long — UI staleness risk" ;;
  *) fail "SIGNALS_SWR_FRESH_MS=$SWR non-numeric" ;;
esac

COLD="${E[SIGNALS_SWR_COLD_TIMEOUT_MS]:-}"
case "$(num "$COLD" 5000 60000)" in
  ok) ok "SIGNALS_SWR_COLD_TIMEOUT_MS=$COLD" ;;
  unset) warn 'SIGNALS_SWR_COLD_TIMEOUT_MS unset — defaults to 10s; consider 15000 if MySQL is saturated' ;;
  too-low) warn "SIGNALS_SWR_COLD_TIMEOUT_MS=$COLD short — empty fallbacks under DB pressure" ;;
  too-high) warn "SIGNALS_SWR_COLD_TIMEOUT_MS=$COLD too long — request hang risk" ;;
  *) fail "SIGNALS_SWR_COLD_TIMEOUT_MS non-numeric" ;;
esac

# ── 5. Candle refresh ─────────────────────────────────────────────
echo
echo '[5] Candle refresh (Yahoo)'
CRI="${E[CANDLE_REFRESH_INTERVAL_MS]:-}"
case "$(num "$CRI" 60000 3600000)" in
  ok)
    if [ "$CRI" -lt 300000 ]; then
      warn "CANDLE_REFRESH_INTERVAL_MS=$CRI (~$((CRI/60000)) min). Yahoo upstream only mutates every 5 min — faster polling wastes load."
    else
      ok "CANDLE_REFRESH_INTERVAL_MS=$CRI (~$((CRI/60000)) min)"
    fi
    ;;
  unset) ok 'CANDLE_REFRESH_INTERVAL_MS unset — defaults to 15 min (good)' ;;
  too-low) fail "CANDLE_REFRESH_INTERVAL_MS=$CRI too aggressive — Yahoo rate-limit risk" ;;
  too-high) warn "CANDLE_REFRESH_INTERVAL_MS=$CRI very long — engine may run on stale bars" ;;
  *) fail 'CANDLE_REFRESH_INTERVAL_MS non-numeric' ;;
esac

ESS="${E[ENGINE_STALE_SKIP_MS]:-}"
case "$(num "$ESS" 60000 3600000)" in
  ok) ok "ENGINE_STALE_SKIP_MS=$ESS" ;;
  unset) ok 'ENGINE_STALE_SKIP_MS unset — defaults to 20 min (good with default candle interval)' ;;
  too-low) fail 'ENGINE_STALE_SKIP_MS too short — engine skips signals at every refresh tail' ;;
  too-high) warn 'ENGINE_STALE_SKIP_MS very long — stale bars may produce signals' ;;
  *) fail 'ENGINE_STALE_SKIP_MS non-numeric' ;;
esac

if [ -n "$CRI" ] && [ -n "$ESS" ] && [ "$CRI" -ge "$ESS" ]; then
  fail "CANDLE_REFRESH_INTERVAL_MS ($CRI) >= ENGINE_STALE_SKIP_MS ($ESS) — engine will reject every refresh as stale"
fi

# ── 6. Hard limits ────────────────────────────────────────────────
echo
echo '[6] /api/signals hard limits'
TC="${E[SIGNALS_TARGET_CAP]:-}"
case "$(num "$TC" 50 1000)" in
  ok) ok "SIGNALS_TARGET_CAP=$TC" ;;
  unset) ok 'SIGNALS_TARGET_CAP unset — defaults to 250 (clamped to 100 by limit param)' ;;
  too-low) warn "SIGNALS_TARGET_CAP=$TC will be clamped UP to 50" ;;
  too-high) warn "SIGNALS_TARGET_CAP=$TC will be clamped DOWN to 1000" ;;
  *) fail 'SIGNALS_TARGET_CAP non-numeric' ;;
esac

ML="${E[SIGNALS_MAX_LIMIT]:-}"
case "$(num "$ML" 50 5000)" in
  ok) ok "SIGNALS_MAX_LIMIT=$ML" ;;
  unset) ok 'SIGNALS_MAX_LIMIT unset — defaults to 1000 (good)' ;;
  too-low) warn "SIGNALS_MAX_LIMIT=$ML will be clamped UP to 50" ;;
  too-high) warn "SIGNALS_MAX_LIMIT=$ML will be clamped DOWN to 5000" ;;
  *) fail 'SIGNALS_MAX_LIMIT non-numeric' ;;
esac

# ── 7. Snapshot validity ──────────────────────────────────────────
echo
echo '[7] Confirmed snapshot validity'
CSV="${E[CONFIRMED_SNAPSHOT_VALIDITY_MINUTES]:-}"
case "$(num "$CSV" 60 120)" in
  ok) ok "CONFIRMED_SNAPSHOT_VALIDITY_MINUTES=$CSV" ;;
  unset) ok 'CONFIRMED_SNAPSHOT_VALIDITY_MINUTES unset — defaults to 90 (good)' ;;
  too-low) warn "CONFIRMED_SNAPSHOT_VALIDITY_MINUTES=$CSV will be clamped UP to 60" ;;
  too-high) warn "CONFIRMED_SNAPSHOT_VALIDITY_MINUTES=$CSV will be clamped DOWN to 120" ;;
  *) fail 'CONFIRMED_SNAPSHOT_VALIDITY_MINUTES non-numeric' ;;
esac

# ── 8. Session ────────────────────────────────────────────────────
echo
echo '[8] Session'
SMA="${E[SESSION_MAX_AGE]:-}"
case "$(num "$SMA" 600 2592000)" in
  ok) ok "SESSION_MAX_AGE=$SMA (~$((SMA/3600))h)" ;;
  unset) warn 'SESSION_MAX_AGE unset — defaults to 86400 (24h)' ;;
  too-low) fail 'SESSION_MAX_AGE under 10 min — users will be logged out mid-session' ;;
  too-high) warn 'SESSION_MAX_AGE > 30 days — security risk' ;;
  *) fail 'SESSION_MAX_AGE non-numeric' ;;
esac

# ── 9. Process state ──────────────────────────────────────────────
echo
echo '[9] Live process state (read from running OS)'
LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo '?')
LOAD_INT=${LOAD%.*}
if [ -n "$LOAD_INT" ] && [ "$LOAD_INT" != '?' ]; then
  if [ "$LOAD_INT" -ge 10 ]; then
    fail "load average = $LOAD (system is overloaded; queries are queueing)"
  elif [ "$LOAD_INT" -ge 5 ]; then
    warn "load average = $LOAD (elevated; investigate top-of-list processes)"
  else
    ok "load average = $LOAD"
  fi
fi

NODE_PROCS=$(pgrep -fc 'next start\|next-server\|npm.*start\|npm.*dev' 2>/dev/null || echo 0)
if [ "$NODE_PROCS" -gt 1 ]; then
  fail "$NODE_PROCS Node/Next processes running — likely duplicates competing for resources. Run: ps aux | grep -E 'node|next' | grep -v grep   to identify and kill the wrong one."
elif [ "$NODE_PROCS" = '1' ]; then
  ok '1 Node/Next process running'
else
  warn 'No Node/Next process detected — is the app actually running?'
fi

if pgrep -x mysqld >/dev/null 2>&1; then
  MYSQL_CPU=$(ps -o %cpu= -p "$(pgrep -x mysqld | head -1)" 2>/dev/null | tr -d ' ')
  if [ -n "$MYSQL_CPU" ]; then
    MYSQL_CPU_INT=${MYSQL_CPU%.*}
    if [ "$MYSQL_CPU_INT" -gt 200 ]; then
      fail "mysqld at ${MYSQL_CPU}% CPU — runaway query or missing index. Run: mysql -e 'SHOW PROCESSLIST;'"
    elif [ "$MYSQL_CPU_INT" -gt 80 ]; then
      warn "mysqld at ${MYSQL_CPU}% CPU"
    else
      ok "mysqld CPU = ${MYSQL_CPU}%"
    fi
  fi
fi

# ── Verdict ───────────────────────────────────────────────────────
echo
echo '================================================================'
printf 'Result:  %d passed, %d warnings, %d failures\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo '✗ NOT PRODUCTION READY — fix the ✗ failures above first.'
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo
  echo '⚠ Production-runnable but has warnings — review the ⚠ lines.'
  exit 0
else
  echo
  echo '✓ All checks passed. Production environment looks good.'
  exit 0
fi
