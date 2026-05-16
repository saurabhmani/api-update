#!/usr/bin/env bash
# scripts/diagnoseLiveVsLocal.sh
#
# Self-contained bash diagnostic — no Node, no tsx required. Logs into
# two deployments and compares /api/signals + /api/signals/freshness
# side-by-side, then prints a verdict on what's diverging and why.
#
# Requires: curl, jq.
#
# Usage:
#   LOCAL_URL=http://localhost:3000 \
#   LIVE_URL=https://quantorus.in \
#   LOCAL_EMAIL='john@quantorus365.in' LOCAL_PASS='John@12345' \
#   LIVE_EMAIL='you@yourdomain.com'    LIVE_PASS='your-prod-pass' \
#     bash scripts/diagnoseLiveVsLocal.sh
#
# Exit code: 0 if identical, 1 if any divergence, 2 on script error.

set -uo pipefail

require() {
  if [ -z "${!1:-}" ]; then echo "Missing env var: $1" >&2; exit 2; fi
}
for v in LOCAL_URL LIVE_URL LOCAL_EMAIL LOCAL_PASS LIVE_EMAIL LIVE_PASS; do
  require "$v"
done

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install with: apt-get install -y jq  (or yum / brew)" >&2
  exit 2
fi

TMPDIR="${TMPDIR:-/tmp}"
LOCAL_COOKIE="$TMPDIR/diag_local_cookie.$$"
LIVE_COOKIE="$TMPDIR/diag_live_cookie.$$"
LOCAL_SIG="$TMPDIR/diag_local_sig.$$.json"
LIVE_SIG="$TMPDIR/diag_live_sig.$$.json"
LOCAL_FRESH="$TMPDIR/diag_local_fresh.$$.json"
LIVE_FRESH="$TMPDIR/diag_live_fresh.$$.json"
trap 'rm -f "$LOCAL_COOKIE" "$LIVE_COOKIE" "$LOCAL_SIG" "$LIVE_SIG" "$LOCAL_FRESH" "$LIVE_FRESH"' EXIT

login() {
  local url="$1" email="$2" pass="$3" cookie="$4"
  local payload status
  payload=$(jq -nc --arg e "$email" --arg p "$pass" '{action:"login", email:$e, password:$p}')
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -c "$cookie" \
    -X POST "$url/api/auth" \
    -H 'Content-Type: application/json' \
    -d "$payload" || echo '000')
  echo "$status"
}

fetch_json() {
  local url="$1" path="$2" cookie="$3" out="$4"
  local status
  status=$(curl -s -o "$out" -w '%{http_code}' \
    -b "$cookie" \
    "$url$path" || echo '000')
  echo "$status"
}

j() { jq -r "$1" "$2" 2>/dev/null || echo '—'; }

bar() { printf '%s\n' "------------------------------------------------------------------------------------------------"; }

row() {
  # row "label" "LOCAL" "LIVE"
  local label="$1" a="$2" b="$3" flag=''
  [ "$a" != "$b" ] && flag='   ⚠ DIVERGENT'
  printf '  %-28s %-34s  %-34s%s\n' "$label" "$a" "$b" "$flag"
}

printf '\nDiagnose: comparing LOCAL (%s) vs LIVE (%s)\n' "$LOCAL_URL" "$LIVE_URL"
bar

# ─── 1. Auth ────────────────────────────────────────────────────────────
LOCAL_AUTH=$(login "$LOCAL_URL" "$LOCAL_EMAIL" "$LOCAL_PASS" "$LOCAL_COOKIE")
LIVE_AUTH=$(login  "$LIVE_URL"  "$LIVE_EMAIL"  "$LIVE_PASS"  "$LIVE_COOKIE")
LOCAL_HAS_COOKIE='no'; [ -s "$LOCAL_COOKIE" ] && grep -q q200_session "$LOCAL_COOKIE" && LOCAL_HAS_COOKIE='yes'
LIVE_HAS_COOKIE='no';  [ -s "$LIVE_COOKIE"  ] && grep -q q200_session "$LIVE_COOKIE"  && LIVE_HAS_COOKIE='yes'

echo ''
echo '[1] Authentication'
row 'login HTTP status' "$LOCAL_AUTH" "$LIVE_AUTH"
row 'cookie set?'        "$LOCAL_HAS_COOKIE" "$LIVE_HAS_COOKIE"

if [ "$LOCAL_AUTH" != "$LIVE_AUTH" ]; then
  echo '  ⚠ DIVERGENT: same/different credentials gave different auth results.'
  echo '    Most likely cause: local and live point at SEPARATE user databases.'
fi

# Fail-soft: continue what we can if at least one side authed.
PROCEED='no'
[ "$LOCAL_HAS_COOKIE" = 'yes' ] && [ "$LIVE_HAS_COOKIE" = 'yes' ] && PROCEED='yes'

if [ "$PROCEED" != 'yes' ]; then
  echo ''
  echo '[!] Cannot continue full diff — at least one side failed to authenticate.'
  echo '    Check the failing environment first, then re-run.'
  exit 1
fi

# ─── 2. /api/signals ────────────────────────────────────────────────────
LOCAL_SIG_STATUS=$(fetch_json "$LOCAL_URL" '/api/signals?action=all&limit=100' "$LOCAL_COOKIE" "$LOCAL_SIG")
LIVE_SIG_STATUS=$( fetch_json "$LIVE_URL"  '/api/signals?action=all&limit=100' "$LIVE_COOKIE"  "$LIVE_SIG")

echo ''
echo '[2] /api/signals?action=all  side-by-side'
printf '  %-28s %-34s  %-34s\n' 'field' 'LOCAL' 'LIVE'
echo "  $(printf '%.s-' {1..94})"

row 'http_status'           "$LOCAL_SIG_STATUS" "$LIVE_SIG_STATUS"

L_RGEN=$(j '.response_generated_at // "—"' "$LOCAL_SIG")
V_RGEN=$(j '.response_generated_at // "—"' "$LIVE_SIG")
printf '  %-28s %-34s  %-34s\n' 'response_generated_at' "$L_RGEN" "$V_RGEN"

L_VS=$(j '.validation_status // "—"' "$LOCAL_SIG"); V_VS=$(j '.validation_status // "—"' "$LIVE_SIG")
row 'validation_status' "$L_VS" "$V_VS"

L_SRC=$(j '.source // "—"' "$LOCAL_SIG"); V_SRC=$(j '.source // "—"' "$LIVE_SIG")
row 'source' "$L_SRC" "$V_SRC"

L_DS=$(j '.data_source // "—"' "$LOCAL_SIG"); V_DS=$(j '.data_source // "—"' "$LIVE_SIG")
row 'data_source' "$L_DS" "$V_DS"

L_BID=$(j '.latest_batch_id // "—"' "$LOCAL_SIG"); V_BID=$(j '.latest_batch_id // "—"' "$LIVE_SIG")
row 'latest_batch_id' "$L_BID" "$V_BID"

L_LPR=$(j '.last_pipeline_run // "—"' "$LOCAL_SIG"); V_LPR=$(j '.last_pipeline_run // "—"' "$LIVE_SIG")
row 'last_pipeline_run' "$L_LPR" "$V_LPR"

L_MAIN=$(j '.main_signals_count // 0' "$LOCAL_SIG"); V_MAIN=$(j '.main_signals_count // 0' "$LIVE_SIG")
row 'main_signals_count' "$L_MAIN" "$V_MAIN"

L_BUY=$(j '.buy_count // 0' "$LOCAL_SIG"); V_BUY=$(j '.buy_count // 0' "$LIVE_SIG")
row 'buy_count' "$L_BUY" "$V_BUY"

L_SELL=$(j '.sell_count // 0' "$LOCAL_SIG"); V_SELL=$(j '.sell_count // 0' "$LIVE_SIG")
row 'sell_count' "$L_SELL" "$V_SELL"

L_EMER=$(j '.emerging_count // 0' "$LOCAL_SIG"); V_EMER=$(j '.emerging_count // 0' "$LIVE_SIG")
row 'emerging_count' "$L_EMER" "$V_EMER"

# ─── 3. Classification distribution ────────────────────────────────────
echo ''
echo '[3] Classification distribution in main grid'
ALL_CLS=$(jq -s -r '
  ([.[0].signals // [] | .[].classification // "(null)" | ascii_upcase] +
   [.[1].signals // [] | .[].classification // "(null)" | ascii_upcase])
  | unique[]
' "$LOCAL_SIG" "$LIVE_SIG" 2>/dev/null)

while IFS= read -r cls; do
  [ -z "$cls" ] && continue
  L_N=$(jq -r --arg c "$cls" '[.signals[]? | select((.classification // "(null)" | ascii_upcase) == $c)] | length' "$LOCAL_SIG")
  V_N=$(jq -r --arg c "$cls" '[.signals[]? | select((.classification // "(null)" | ascii_upcase) == $c)] | length' "$LIVE_SIG")
  row "  $cls" "$L_N" "$V_N"
done <<< "$ALL_CLS"

# ─── 4. Symbol-set diff ────────────────────────────────────────────────
echo ''
echo '[4] Main-grid symbol set'
SHARED=$(jq -s -r '
  (.[0].signals // [] | map(.tradingsymbol // .symbol // "")) as $a |
  (.[1].signals // [] | map(.tradingsymbol // .symbol // "")) as $b |
  ($a | map(select(. as $x | $b | index($x))) | unique | length)
' "$LOCAL_SIG" "$LIVE_SIG" 2>/dev/null)
ONLY_LOCAL=$(jq -s -r '
  (.[0].signals // [] | map(.tradingsymbol // .symbol // "")) as $a |
  (.[1].signals // [] | map(.tradingsymbol // .symbol // "")) as $b |
  ($a - $b) | unique
' "$LOCAL_SIG" "$LIVE_SIG" 2>/dev/null)
ONLY_LIVE=$(jq -s -r '
  (.[0].signals // [] | map(.tradingsymbol // .symbol // "")) as $a |
  (.[1].signals // [] | map(.tradingsymbol // .symbol // "")) as $b |
  ($b - $a) | unique
' "$LOCAL_SIG" "$LIVE_SIG" 2>/dev/null)
N_LOCAL=$(echo "$ONLY_LOCAL" | jq 'length' 2>/dev/null || echo 0)
N_LIVE=$( echo "$ONLY_LIVE"  | jq 'length' 2>/dev/null || echo 0)

echo "  shared:    ${SHARED} symbol(s)"
LOCAL_LIST=$(echo "$ONLY_LOCAL" | jq -r '.[:12] | join(", ")' 2>/dev/null)
LIVE_LIST=$( echo "$ONLY_LIVE"  | jq -r '.[:12] | join(", ")' 2>/dev/null)
echo "  only LOCAL: ${N_LOCAL} symbol(s)${LOCAL_LIST:+ → $LOCAL_LIST}"
echo "  only LIVE:  ${N_LIVE} symbol(s)${LIVE_LIST:+ → $LIVE_LIST}"

# ─── 5. /api/signals/freshness ─────────────────────────────────────────
LOCAL_FRESH_STATUS=$(fetch_json "$LOCAL_URL" '/api/signals/freshness' "$LOCAL_COOKIE" "$LOCAL_FRESH")
LIVE_FRESH_STATUS=$( fetch_json "$LIVE_URL"  '/api/signals/freshness' "$LIVE_COOKIE"  "$LIVE_FRESH")

echo ''
echo '[5] /api/signals/freshness  side-by-side'
printf '  %-28s %-34s  %-34s\n' 'field' 'LOCAL' 'LIVE'
echo "  $(printf '%.s-' {1..94})"
row 'http_status' "$LOCAL_FRESH_STATUS" "$LIVE_FRESH_STATUS"

L_AC=$(j '.freshness.active_confirmed_count // 0' "$LOCAL_FRESH"); V_AC=$(j '.freshness.active_confirmed_count // 0' "$LIVE_FRESH")
row 'active_confirmed_count' "$L_AC" "$V_AC"

L_LCA=$(j '.freshness.latest_confirmed_at // "—"' "$LOCAL_FRESH"); V_LCA=$(j '.freshness.latest_confirmed_at // "—"' "$LIVE_FRESH")
row 'latest_confirmed_at' "$L_LCA" "$V_LCA"

L_FBID=$(j '.freshness.latest_batch_id // "—"' "$LOCAL_FRESH"); V_FBID=$(j '.freshness.latest_batch_id // "—"' "$LIVE_FRESH")
row 'latest_batch_id (freshness)' "$L_FBID" "$V_FBID"

L_TOT=$(j '.freshness.total_stored_signals // 0' "$LOCAL_FRESH"); V_TOT=$(j '.freshness.total_stored_signals // 0' "$LIVE_FRESH")
row 'total_stored_signals' "$L_TOT" "$V_TOT"

L_CTS=$(j '.freshness.candle_latest_ts // "—"' "$LOCAL_FRESH"); V_CTS=$(j '.freshness.candle_latest_ts // "—"' "$LIVE_FRESH")
row 'candle_latest_ts' "$L_CTS" "$V_CTS"

L_TT=$(j '.freshness.tracker_counts.total // 0' "$LOCAL_FRESH"); V_TT=$(j '.freshness.tracker_counts.total // 0' "$LIVE_FRESH")
row 'tracker_total' "$L_TT" "$V_TT"

# ─── 6. Verdict ────────────────────────────────────────────────────────
echo ''
echo '[6] Verdict'
ANY_DIFF=0
record() { local same="$1" label="$2" hint="$3"
  if [ "$same" = 'yes' ]; then
    printf '  ✓ SAME      %s\n' "$label"
  else
    printf '  ✗ DIFFERS   %s   →  %s\n' "$label" "$hint"
    ANY_DIFF=1
  fi
}
[ "$LOCAL_AUTH" = "$LIVE_AUTH" ] && AUTH_SAME='yes' || AUTH_SAME='no'
record "$AUTH_SAME" 'same user database' 'auth result differs → user tables are not shared'

[ "$L_BID" = "$V_BID" ] && BID_SAME='yes' || BID_SAME='no'
record "$BID_SAME" 'same scanner batch' 'latest_batch_id differs → independent scanners running on each side'

[ "$L_MAIN" = "$V_MAIN" ] && CNT_SAME='yes' || CNT_SAME='no'
record "$CNT_SAME" 'same main grid count' 'main_signals_count differs → filter or supply mismatch'

[ "$N_LOCAL" = '0' ] && [ "$N_LIVE" = '0' ] && SYM_SAME='yes' || SYM_SAME='no'
record "$SYM_SAME" 'identical symbol set' 'symbol set differs → grids are not the same data'

[ "$L_AC" = "$V_AC" ] && AC_SAME='yes' || AC_SAME='no'
record "$AC_SAME" 'same active confirmed count' 'active_confirmed_count differs → confirmed-snapshot tables are not shared'

[ "$L_TOT" = "$V_TOT" ] && TOT_SAME='yes' || TOT_SAME='no'
record "$TOT_SAME" 'same total stored signals' 'total_stored_signals differs → q365_signals tables are not shared'

if [ "$ANY_DIFF" = '0' ]; then
  echo ''
  echo '  No divergence detected — local and live are returning identical state.'
  exit 0
fi

echo ''
echo '  Most likely root cause:'
if [ "$AUTH_SAME" = 'no' ]; then
  cat <<'EOF'
  → Two SEPARATE databases (different user tables prove it).
    Each environment runs its own engine + scheduler against its own DB.
    They will always diverge unless you point both at one DB or set up replication.
EOF
elif [ "$BID_SAME" = 'no' ]; then
  cat <<'EOF'
  → Same DB, but two writers competing.
    Disable the scheduler on the secondary process:
      Q365_INPROC_SCHEDULER=0 Q365_INPROC_REGEN=0 npm run start
EOF
else
  cat <<'EOF'
  → Code or filter mismatch between the two environments.
    Compare git rev-parse HEAD on both, plus relevant env vars (V2.10
    floors, Q365_INPROC_REGEN, SIGNALS_TARGET_CAP, etc.).
EOF
fi

exit 1
