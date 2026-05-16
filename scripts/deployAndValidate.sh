#!/usr/bin/env bash
# scripts/deployAndValidate.sh
#
# Build → restart PM2 (if available) → validate the Signal Engine.
#
# Two modes, picked automatically:
#
#   1. HTTP_AUTH        — Q365_SESSION_COOKIE is exported.
#                         Hits /api/signals over HTTP with the cookie,
#                         confirms BUY/SELL counts the live UI sees.
#
#   2. LOCAL_CLI        — no cookie set AND (NODE_ENV=development OR
#                         Q365_LOCAL_VALIDATE=true).
#                         Bypasses HTTP entirely; runs the same engine
#                         the route runs (generateOneBatch.ts) and
#                         then the in-process /signals route simulator
#                         (validateSignalsRoute.ts). Identical DB
#                         side effects, no cookie required.
#
# In production with no cookie and no opt-in env, the script fails
# securely — it WILL NOT silently weaken production auth.
#
# Usage:
#
#   # Local dev — no cookie needed:
#   export Q365_LOCAL_VALIDATE=true
#   bash scripts/deployAndValidate.sh
#
#   # Or rely on NODE_ENV=development being set:
#   NODE_ENV=development bash scripts/deployAndValidate.sh
#
#   # Production deploy — full HTTP path, requires cookie:
#   export Q365_SESSION_COOKIE='q200_session=abc123...'
#   bash scripts/deployAndValidate.sh
#
set -euo pipefail

PORT="${PORT:-5000}"
APP_NAME="${APP_NAME:-quantorus365-app}"
COOKIE="${Q365_SESSION_COOKIE:-}"
LOCAL_VALIDATE="${Q365_LOCAL_VALIDATE:-}"
NODE_ENV="${NODE_ENV:-}"

# ── Mode selection ───────────────────────────────────────────────
if [[ -n "$COOKIE" ]]; then
  MODE="HTTP_AUTH"
elif [[ "$LOCAL_VALIDATE" == "true" || "$NODE_ENV" == "development" ]]; then
  MODE="LOCAL_CLI"
else
  echo "═════════════════════════════════════════════════════════════════"
  echo "ERROR: no validation mode available."
  echo "═════════════════════════════════════════════════════════════════"
  echo "  Q365_SESSION_COOKIE is not set, and neither"
  echo "  NODE_ENV=development nor Q365_LOCAL_VALIDATE=true is set."
  echo ""
  echo "  Pick ONE of the following:"
  echo ""
  echo "  A) Local dev validation (no cookie needed):"
  echo "       export Q365_LOCAL_VALIDATE=true"
  echo "       bash scripts/deployAndValidate.sh"
  echo ""
  echo "  B) HTTP / browser-session validation (cookie required):"
  echo "       # Open an authenticated browser tab → DevTools → Application"
  echo "       # → Cookies → copy the 'q200_session=...' line."
  echo "       export Q365_SESSION_COOKIE='q200_session=...'"
  echo "       bash scripts/deployAndValidate.sh"
  echo "═════════════════════════════════════════════════════════════════"
  exit 1
fi

echo "═════════════════════════════════════════════════════════════════"
echo "Quantorus365 deploy + validate"
echo "═════════════════════════════════════════════════════════════════"
echo "  validation mode: $MODE"
echo "  port:            $PORT"
echo "  pm2 app:         $APP_NAME"
echo

# ── Step 1: build (production) ───────────────────────────────────
# In LOCAL_CLI mode we skip the build because the CLI scripts run
# tsx-compiled TypeScript directly — they don't need .next/ to be
# fresh. Skipping saves the operator the ~60s build wait per run.
if [[ "$MODE" == "HTTP_AUTH" ]]; then
  echo "─────────────────────────────────────────────────────────────────"
  echo "1/4  npm run build  (compiles .next/server/app)"
  echo "─────────────────────────────────────────────────────────────────"
  rm -rf .next
  npm run build

  if command -v pm2 >/dev/null 2>&1; then
    echo
    echo "─────────────────────────────────────────────────────────────────"
    echo "2/4  pm2 restart $APP_NAME --update-env"
    echo "─────────────────────────────────────────────────────────────────"
    pm2 restart "$APP_NAME" --update-env || echo "  (pm2 restart failed — continuing; manual restart may be needed)"
  else
    echo "  pm2 not on PATH — skipping restart. Restart your dev server manually."
  fi

  echo
  echo "─────────────────────────────────────────────────────────────────"
  echo "3/4  Waiting for /api/signals to come up…"
  echo "─────────────────────────────────────────────────────────────────"
  for i in $(seq 1 30); do
    if curl -fsS -H "Cookie: $COOKIE" "http://localhost:${PORT}/api/signals?action=all&limit=1" >/dev/null 2>&1; then
      echo "  ready after ${i}s"
      break
    fi
    sleep 1
  done
fi

# ── Step 2: HTTP_AUTH validation ─────────────────────────────────
if [[ "$MODE" == "HTTP_AUTH" ]]; then
  echo
  echo "─────────────────────────────────────────────────────────────────"
  echo "4/4  Hitting /api/signals?action=all&limit=50"
  echo "─────────────────────────────────────────────────────────────────"
  RESP=$(curl -fsS -H "Cookie: $COOKIE" "http://localhost:${PORT}/api/signals?action=all&limit=50")

  echo
  echo "── Counts ────────────────────────────────────────────────────"
  echo "$RESP" | jq -r '{
    total:               .count,
    direction_breakdown: .direction_breakdown,
    emerging_count:      .emerging_count,
    topped_up_count:     .topped_up_count
  }'

  echo
  echo "── Freshness ─────────────────────────────────────────────────"
  echo "$RESP" | jq -r '.freshness | {
    last_pipeline_run,
    last_validation_time,
    latest_batch_id,
    latest_batch_symbols,
    universe_size,
    scan_coverage_percent,
    data_source
  }'

  echo
  echo "── Live sanity report ───────────────────────────────────────"
  echo "$RESP" | jq -r '.live_sanity_report // {note: "live_sanity_report missing — old build still serving"}'

  echo
  echo "── First 3 BUY rows ─────────────────────────────────────────"
  echo "$RESP" | jq -r '[.signals[] | select(.direction=="BUY")][:3] | map({tradingsymbol, final_score, livePrice, entry_price, stop_loss})'

  echo
  echo "── First 3 SELL rows ────────────────────────────────────────"
  echo "$RESP" | jq -r '[.signals[] | select(.direction=="SELL")][:3] | map({tradingsymbol, final_score, livePrice, entry_price, stop_loss})'

  BUY=$(echo "$RESP" | jq -r '.direction_breakdown.BUY // 0')
  SELL=$(echo "$RESP" | jq -r '.direction_breakdown.SELL // 0')
  TOTAL=$(echo "$RESP" | jq -r '.count // 0')
  EMERGING=$(echo "$RESP" | jq -r '.emerging_count // 0')
  COVERAGE=$(echo "$RESP" | jq -r '.freshness.scan_coverage_percent // "?"')
  BATCH=$(echo "$RESP" | jq -r '.freshness.latest_batch_id // "?"')

  echo
  echo "═════════════════════════════════════════════════════════════════"
  echo "VALIDATION REPORT — mode: HTTP_AUTH"
  echo "═════════════════════════════════════════════════════════════════"
  echo "  latest_batch_id:        $BATCH"
  echo "  total signals:          $TOTAL"
  echo "  buy count:              $BUY"
  echo "  sell count:             $SELL"
  echo "  emerging count:         $EMERGING"
  echo "  scan coverage:          $COVERAGE%"
  if [[ "$BUY" -ge 5 && "$SELL" -ge 1 ]]; then
    echo "  2 BUY / 0 SELL bug:     RESOLVED ✓"
    echo
    echo "  VERDICT: FIXED_AND_VISIBLE_IN_UI ✓"
  elif [[ "$BUY" -ge 2 && "$SELL" -eq 0 ]]; then
    echo "  2 BUY / 0 SELL bug:     STILL PRESENT ✗"
    echo
    echo "  VERDICT: NOT_FIXED"
    echo "  Hint: run the scanner to populate fresh signals:"
    echo "    npx tsx scripts/generateOneBatch.ts --scanner"
    exit 2
  else
    echo
    echo "  VERDICT: indeterminate (open the JSON above and inspect)"
    exit 3
  fi
  exit 0
fi

# ── Step 3: LOCAL_CLI validation ─────────────────────────────────
if [[ "$MODE" == "LOCAL_CLI" ]]; then
  echo "─────────────────────────────────────────────────────────────────"
  echo "Local CLI mode — bypassing HTTP, running engine + simulator in-process."
  echo "(Same DB side effects as the HTTP route. No session cookie needed.)"
  echo "─────────────────────────────────────────────────────────────────"

  # Step A: trigger a fresh full-universe scanner run.
  # Scanner is the path that produces the populated 400+ row batch
  # the UI ultimately consumes. Phase-4 (the strict canonical engine)
  # is also runnable via `npx tsx scripts/generateOneBatch.ts` (no
  # --scanner flag) but tends to produce few rows in sideways markets;
  # for a "full populated table" we want the scanner.
  echo
  echo "─────────────────────────────────────────────────────────────────"
  echo "1/2  npx tsx scripts/generateOneBatch.ts --scanner --full"
  echo "─────────────────────────────────────────────────────────────────"
  SCAN_OUTPUT=$(mktemp)
  if npx tsx scripts/generateOneBatch.ts --scanner --full 2>&1 | tee "$SCAN_OUTPUT"; then
    SCAN_EXIT=0
  else
    SCAN_EXIT=$?
  fi

  # Pull the structured fields out of the scanner's printed summary.
  BATCH_LOCAL=$(grep -E "^\s+batch_id:" "$SCAN_OUTPUT" | awk '{print $2}' | tail -1)
  BUY_LOCAL=$(grep -E "^\s+buy_count:" "$SCAN_OUTPUT" | awk '{print $2}' | tail -1)
  SELL_LOCAL=$(grep -E "^\s+sell_count:" "$SCAN_OUTPUT" | awk '{print $2}' | tail -1)
  COVERAGE_LOCAL=$(grep -E "^\s+scan_coverage_percent:" "$SCAN_OUTPUT" | awk '{print $2}' | tail -1)
  APPROVED_LOCAL=$(grep -E "^\s+approved:" "$SCAN_OUTPUT" | awk '{print $2}' | tail -1)
  WATCH_LOCAL=$(grep -E "^\s+watchlist:" "$SCAN_OUTPUT" | awk '{print $2}' | tail -1)

  rm -f "$SCAN_OUTPUT"

  # Step B: route simulator — exercises getActiveSignals + the
  # post-fix per-direction window SQL + applyLiveSanity buffered logic
  # + Phase-12 partition. This is the closest thing to "what /api/signals
  # would return RIGHT NOW" without going through HTTP.
  echo
  echo "─────────────────────────────────────────────────────────────────"
  echo "2/2  npx tsx scripts/validateSignalsRoute.ts"
  echo "─────────────────────────────────────────────────────────────────"
  SIM_OUTPUT=$(mktemp)
  if npx tsx scripts/validateSignalsRoute.ts 2>&1 | tee "$SIM_OUTPUT"; then
    SIM_EXIT=0
  else
    SIM_EXIT=$?
  fi

  MAIN_BUY=$(grep -E "^\s+Final main-table BUY:" "$SIM_OUTPUT" | awk '{print $NF}' | tail -1)
  MAIN_SELL=$(grep -E "^\s+Final main-table SELL:" "$SIM_OUTPUT" | awk '{print $NF}' | tail -1)
  rm -f "$SIM_OUTPUT"

  echo
  echo "═════════════════════════════════════════════════════════════════"
  echo "VALIDATION REPORT — mode: LOCAL_CLI"
  echo "═════════════════════════════════════════════════════════════════"
  echo "  latest_batch_id:           ${BATCH_LOCAL:-?}"
  echo "  scanner buy_count:         ${BUY_LOCAL:-?}"
  echo "  scanner sell_count:        ${SELL_LOCAL:-?}"
  echo "  approved + watchlist:      ${APPROVED_LOCAL:-?} + ${WATCH_LOCAL:-?}"
  echo "  scan coverage:             ${COVERAGE_LOCAL:-?}%"
  echo "  route-sim main BUY:        ${MAIN_BUY:-?}"
  echo "  route-sim main SELL:       ${MAIN_SELL:-?}"
  echo
  if [[ -n "${MAIN_BUY:-}" && -n "${MAIN_SELL:-}" \
        && "${MAIN_BUY}" =~ ^[0-9]+$ && "${MAIN_SELL}" =~ ^[0-9]+$ \
        && "${MAIN_BUY}" -ge 5 && "${MAIN_SELL}" -ge 1 ]]; then
    echo "  2 BUY / 0 SELL bug:        RESOLVED ✓"
    echo
    echo "  VERDICT: FIXED_IN_CODE_LOCAL_VALIDATION_ONLY"
    echo "  (UI/browser path not validated — set Q365_SESSION_COOKIE for HTTP_AUTH mode)"
    exit 0
  elif [[ "${MAIN_BUY:-0}" -ge 2 && "${MAIN_SELL:-0}" -eq 0 ]]; then
    echo "  2 BUY / 0 SELL bug:        STILL PRESENT ✗"
    echo
    echo "  VERDICT: NOT_FIXED"
    exit 2
  else
    echo "  VERDICT: indeterminate — read the per-step output above"
    if [[ "$SCAN_EXIT" -ne 0 || "$SIM_EXIT" -ne 0 ]]; then
      echo "  (scanner exit=$SCAN_EXIT, simulator exit=$SIM_EXIT)"
    fi
    exit 3
  fi
fi
