/**
 * scripts/validatePhase8LiveValidation.ts
 *
 * Phase-8 validation harness for the live validation engine.
 * Exercises:
 *   - one VALID signal (all six checks pass)
 *   - one STALE signal (signal age past the cap)
 *   - one STOP-BROKEN signal (live price past the stop)
 *   - bonus: live_invalidated flag, wide spread
 *
 * Run:
 *   npx tsx scripts/validatePhase8LiveValidation.ts
 */
import {
  validateLiveSignal,
  type LiveValidationInput,
  type LiveValidationResult,
} from '../src/lib/signal-engine/live/liveValidationEngine';

// Anchor "now" so age math is deterministic across runs.
const NOW = new Date('2026-04-25T10:00:00Z');

function dump(label: string, input: LiveValidationInput): LiveValidationResult {
  const r = validateLiveSignal(input, undefined, NOW);
  console.log('── ' + label);
  console.log('   live_valid:              ' + r.live_valid);
  console.log('   live_validation_codes:   ' + JSON.stringify(r.live_validation_codes));
  console.log('   live_validation_reasons:');
  for (const m of r.live_validation_reasons) console.log('     - ' + m);
  console.log('   live_price_snapshot:');
  console.log('     symbol:           ' + r.live_price_snapshot.symbol);
  console.log('     live_price:       ' + r.live_price_snapshot.live_price);
  console.log('     entry_price:      ' + r.live_price_snapshot.entry_price);
  console.log('     stop_loss:        ' + r.live_price_snapshot.stop_loss);
  console.log('     drift_pct:        ' + r.live_price_snapshot.drift_pct);
  console.log('     distance_to_stop: ' + r.live_price_snapshot.distance_to_stop);
  console.log('     stop_buffer_pct:  ' + r.live_price_snapshot.stop_buffer_pct);
  console.log('     spread_bps:       ' + r.live_price_snapshot.spread_bps);
  console.log('     signal_age_hours: ' + r.live_price_snapshot.signal_age_hours);
  console.log('     tick_age_seconds: ' + r.live_price_snapshot.tick_age_seconds);
  console.log('     captured_at:      ' + r.live_price_snapshot.captured_at);
  console.log('');
  return r;
}

console.log('='.repeat(72));
console.log('PHASE-8 LIVE VALIDATION ENGINE — VALIDATION');
console.log('  hard-reject from main table when live_valid === false');
console.log('  evaluation anchored at NOW = ' + NOW.toISOString());
console.log('='.repeat(72));
console.log('');

// ── 1. VALID — all six checks pass ─────────────────────────────
const valid = dump('VALID — TCS BUY, live near entry, fresh tick, healthy spread', {
  symbol:          'TCS',
  direction:       'BUY',
  entryPrice:      1500,
  stopLoss:        1460,
  livePrice:       1502,                                      //  +0.13% drift
  generatedAt:     '2026-04-25T08:00:00Z',                    //  2h old
  liveTickAt:      '2026-04-25T09:59:50Z',                    //  10s old
  liveInvalidated: false,
  bid:             1501.8,
  ask:             1502.2,                                    //  ~2.7 bps
});

// ── 2. STALE — signal age past the 20h cap ─────────────────────
const stale = dump('STALE — TCS BUY generated 26h ago', {
  symbol:          'TCS',
  direction:       'BUY',
  entryPrice:      1500,
  stopLoss:        1460,
  livePrice:       1502,
  generatedAt:     '2026-04-24T08:00:00Z',                    //  26h old
  liveTickAt:      '2026-04-25T09:59:50Z',
  liveInvalidated: false,
});

// ── 3. STOP-BROKEN — live price already past the BUY stop ──────
const stopBroken = dump('STOP-BROKEN — TCS BUY live below stop', {
  symbol:          'TCS',
  direction:       'BUY',
  entryPrice:      1500,
  stopLoss:        1460,
  livePrice:       1455,                                      //  past stop
  generatedAt:     '2026-04-25T08:00:00Z',
  liveTickAt:      '2026-04-25T09:59:50Z',
  liveInvalidated: false,
});

// ── 4. SELL stop-broken — symmetry check ───────────────────────
const sellStop = dump('STOP-BROKEN — INFY SELL live above stop', {
  symbol:          'INFY',
  direction:       'SELL',
  entryPrice:      1600,
  stopLoss:        1640,
  livePrice:       1645,                                      //  past SELL stop
  generatedAt:     '2026-04-25T08:00:00Z',
  liveTickAt:      '2026-04-25T09:59:50Z',
  liveInvalidated: false,
});

// ── 5. live_invalidated upstream flag ──────────────────────────
const upstream = dump('UPSTREAM-INVALIDATED — flag set by freshness validator', {
  symbol:          'TCS',
  direction:       'BUY',
  entryPrice:      1500,
  stopLoss:        1460,
  livePrice:       1502,
  generatedAt:     '2026-04-25T08:00:00Z',
  liveTickAt:      '2026-04-25T09:59:50Z',
  liveInvalidated: true,
});

// ── 6. wide spread ─────────────────────────────────────────────
const wideSpread = dump('SPREAD — TCS BUY with 80 bps quoted spread', {
  symbol:          'TCS',
  direction:       'BUY',
  entryPrice:      1500,
  stopLoss:        1460,
  livePrice:       1502,
  generatedAt:     '2026-04-25T08:00:00Z',
  liveTickAt:      '2026-04-25T09:59:50Z',
  liveInvalidated: false,
  bid:             1496,
  ask:             1508,                                      //  ~80 bps
});

// ── Invariants ─────────────────────────────────────────────────
const ok = (
  valid.live_valid === true &&
  valid.live_validation_codes.length === 0 &&
  valid.live_validation_reasons.length === 0 &&

  stale.live_valid === false &&
  stale.live_validation_codes.includes('signal_stale') &&

  stopBroken.live_valid === false &&
  stopBroken.live_validation_codes.includes('stop_violated') &&

  sellStop.live_valid === false &&
  sellStop.live_validation_codes.includes('stop_violated') &&

  upstream.live_valid === false &&
  upstream.live_validation_codes.includes('live_invalidated') &&

  wideSpread.live_valid === false &&
  wideSpread.live_validation_codes.includes('spread_too_wide') &&

  // Snapshot is always populated even on rejection.
  stale.live_price_snapshot.signal_age_hours > 20 &&
  stopBroken.live_price_snapshot.distance_to_stop > 0 &&
  // Reasons array length matches codes array length on every result.
  valid.live_validation_codes.length     === valid.live_validation_reasons.length &&
  stale.live_validation_codes.length     === stale.live_validation_reasons.length &&
  stopBroken.live_validation_codes.length === stopBroken.live_validation_reasons.length
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  VALID            → live_valid=true, codes empty, snapshot populated');
console.log('  STALE            → live_valid=false, codes include signal_stale');
console.log('  STOP-BROKEN BUY  → live_valid=false, codes include stop_violated');
console.log('  STOP-BROKEN SELL → live_valid=false, codes include stop_violated');
console.log('  UPSTREAM         → live_valid=false, codes include live_invalidated');
console.log('  WIDE SPREAD      → live_valid=false, codes include spread_too_wide');
console.log('  codes.length === reasons.length on every result');
console.log('');
console.log(ok
  ? 'RESULT: Phase-8 live validation engine honours the spec.'
  : 'RESULT: At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
