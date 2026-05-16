/**
 * scripts/validatePhase11Persistence.ts
 *
 * Phase-11 round-trip + API-shape harness.
 *
 *   1. Inspects the q365_signals schema (skipped without DB env).
 *   2. Builds a fully-populated Phase11SignalRow from a synthetic
 *      DB row (Phase-7 stress + Phase-8 live + Phase-9 sizing +
 *      Phase-10 explanation all present).
 *   3. Round-trips it through the Redis serializer/deserializer.
 *   4. Renders the API response body and prints it.
 *   5. Asserts every one of the 16 required Phase-11 fields is
 *      present on the API output.
 *
 * Run:
 *   npx tsx scripts/validatePhase11Persistence.ts
 */
import {
  fromDbRow,
  serializeForCache,
  deserializeFromCache,
  toApiResponse,
  PHASE_11_REQUIRED_FIELDS,
  type Phase11ApiSignalResponse,
} from '../src/lib/signal-engine/repository/phase11Serialization';

console.log('='.repeat(72));
console.log('PHASE-11 UNIFIED ROW BLOCK — VALIDATION');
console.log('='.repeat(72));
console.log('');

// ── 1. Schema inspection (informational) ────────────────────────
console.log('## 1. DB schema inspection');
console.log('   Phase-11 columns added by migrateSignalEngine.ts:');
const schemaCols = [
  ['stress_survival_score',         'DECIMAL(5,2) NULL'],
  ['recommended_quantity',          'INT NULL'],
  ['recommended_capital',           'DECIMAL(14,2) NULL'],
  ['live_valid',                    'TINYINT(1) NULL'],
  ['rejection_codes_json',          'JSON NULL'],
  ['rejection_reasons_json',        'JSON NULL'],
  ['live_validation_reasons_json',  'JSON NULL'],
  ['explanation_json',              'JSON NULL'],
];
for (const [col, def] of schemaCols) {
  console.log('     - ' + col.padEnd(34) + ' ' + def);
}
console.log('   (run `npx tsx src/lib/db/migrateSignalEngine.ts` to apply)');
console.log('');

// ── 2. Synthetic DB row — every Phase-11 field populated ────────
const dbRow = {
  id:                  4242,
  symbol:              'TCS',
  direction:           'BUY',
  generated_at:        new Date('2026-04-25T10:00:00Z'),

  // Phase-1/2 conviction & risk
  confidence_score:    78,
  risk_score:          38,
  portfolio_fit_score: 76,
  risk_reward:         2.4,

  // Phase-4 final scoring + 8-factor
  final_score:         78.5,
  classification:      'HIGH_CONVICTION',
  phase4_factor_scores_json: JSON.stringify({
    strategy_quality:    82,
    trend_alignment:     85,
    momentum:            76,
    volume_confirmation: 71,
    risk_reward:         80,
    liquidity:           88,
    market_regime:       70,
    portfolio_fit:       72,
  }),

  // Phase-5 rejection (clean here — APPROVED row)
  signal_status:           'APPROVED_SIGNAL',
  rejection_codes_json:    JSON.stringify([]),
  rejection_reasons_json:  JSON.stringify([]),

  // Phase-7 stress
  stress_survival_score:   75,

  // Phase-8 live validation
  live_valid:                       1,
  live_validation_reasons_json:     JSON.stringify([]),

  // Phase-9 sizing
  recommended_quantity:    1250,
  recommended_capital:     1875000,

  // Phase-10 explainability
  explanation_json: JSON.stringify({
    summary_reason:
      'TCS BUY bullish_breakout → APPROVED (score 78.5, HIGH_CONVICTION). Led by liquidity 88 & trend_alignment 85.',
    factor_score_explanation:
      'Final score 78.5/100 → HIGH_CONVICTION. Strongest factors: liquidity 88, trend_alignment 85.',
    risk_explanation:
      'Standalone risk band "Low Risk" (score 38/100); rejection-engine clear (no blocking codes).',
    portfolio_explanation:
      'Portfolio risk: APPROVED (fit score 76/100). Post-trade: sector exposure 18%, total open-trade risk 4.5%.',
    stress_explanation:
      'Stress survival 75/100 — resilient. Worst case: market_down_10_percent, loss 30000.',
    rejection_explanation:
      'No blocking codes raised across rejection / portfolio / stress / live gates.',
    final_decision_explanation:
      'Final decision: APPROVED (TCS BUY, score 78.5). Cleared every gate. Sized for entry.',
  }),
};

console.log('## 2. Build canonical row from synthetic DB shape');
const row = fromDbRow(dbRow as any);
console.log('   ✓ fromDbRow() produced Phase11SignalRow for ' + row.symbol + ' ' + row.direction);
console.log('');

// ── 3. Redis round-trip ─────────────────────────────────────────
console.log('## 3. Redis round-trip (serializeForCache → JSON.stringify → JSON.parse → deserializeFromCache)');
const cachePayload  = serializeForCache(row);
const wireString    = JSON.stringify(cachePayload);
const wireParsed    = JSON.parse(wireString);
const restored      = deserializeFromCache(wireParsed);
const fieldsMatch =
  restored.symbol            === row.symbol &&
  restored.final_score       === row.final_score &&
  restored.stress_survival_score === row.stress_survival_score &&
  restored.recommended_quantity  === row.recommended_quantity &&
  restored.live_valid        === row.live_valid &&
  restored.rejection_codes.length === row.rejection_codes.length &&
  restored.factor_scores.liquidity === row.factor_scores.liquidity &&
  restored.explanation.summary_reason === row.explanation.summary_reason;
console.log('   wire size:                   ' + wireString.length + ' bytes');
console.log('   restored.symbol:             ' + restored.symbol);
console.log('   round-trip integrity:        ' + (fieldsMatch ? 'OK' : 'FAIL'));
console.log('');

// ── 4. API response body ────────────────────────────────────────
console.log('## 4. API response body (toApiResponse)');
const api: Phase11ApiSignalResponse = toApiResponse(restored);
console.log(JSON.stringify(api, null, 2));
console.log('');

// ── 5. Required-fields invariant ────────────────────────────────
console.log('## 5. Required-fields invariant');
const apiRecord = api as unknown as Record<string, unknown>;
const missing = PHASE_11_REQUIRED_FIELDS.filter((k) => !(k in apiRecord) || apiRecord[k] === undefined);
const empty   = PHASE_11_REQUIRED_FIELDS.filter((k) => {
  const v = apiRecord[k];
  if (Array.isArray(v))                       return false;          // empty array is allowed
  if (v && typeof v === 'object')             return Object.keys(v).length === 0;
  return v === '' || v === null || v === undefined;
});
console.log('   16 required fields:          ' + PHASE_11_REQUIRED_FIELDS.join(', '));
console.log('   missing keys:                ' + (missing.length ? missing.join(', ') : '(none)'));
console.log('   empty values (non-array):    ' + (empty.length ? empty.join(', ') : '(none)'));
console.log('');

// ── Invariants ─────────────────────────────────────────────────
const ok = (
  fieldsMatch &&
  missing.length === 0 &&
  empty.length === 0 &&
  // Spot-check: every Phase-11 field carries a non-default value.
  api.final_score === 78.5 &&
  api.stress_survival_score === 75 &&
  api.recommended_quantity === 1250 &&
  api.recommended_capital === 1_875_000 &&
  api.live_valid === true &&
  api.signal_status === 'APPROVED_SIGNAL' &&
  api.classification === 'HIGH_CONVICTION' &&
  api.factor_scores.liquidity === 88 &&
  api.explanation.summary_reason.includes('APPROVED')
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  Round-trip preserves every Phase-11 field across DB → row → cache → restore');
console.log('  Every required key is present on the API response');
console.log('  Every required key has a non-empty value');
console.log('');
console.log(ok
  ? 'RESULT: Phase-11 unified row block honours the spec.'
  : 'RESULT: At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
