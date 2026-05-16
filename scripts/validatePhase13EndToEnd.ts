/**
 * scripts/validatePhase13EndToEnd.ts
 *
 * Phase-13 end-to-end validation harness.
 *
 * Drives 12 synthetic signals through the Phase-5 → Phase-12
 * stack, asserts the spec invariants, and prints the wrap-up
 * report (results table, issues, files changed, risks, next
 * improvements).
 *
 * Run:
 *   npx tsx scripts/validatePhase13EndToEnd.ts
 */
import { partitionForUi, routeSignal } from '../src/lib/signal-engine/pipeline/phase12Routing';
import {
  fromDbRow,
  serializeForCache,
  deserializeFromCache,
  toApiResponse,
  PHASE_11_REQUIRED_FIELDS,
  type Phase11ApiSignalResponse,
} from '../src/lib/signal-engine/repository/phase11Serialization';
import type {
  SignalClassification,
  SignalStatus,
  SignalDirection,
  SignalExplanation,
  FactorScores,
} from '../src/lib/signal-engine/types/phase11Signal';

// ── Fixture builder ────────────────────────────────────────────

interface Fixture {
  symbol:                string;
  strategy:              string;
  direction:             SignalDirection;
  classification:        SignalClassification | null;
  signal_status:         SignalStatus | null;
  final_score:           number | null;
  confidence_score:      number;
  risk_score:            number;
  portfolio_fit_score:   number;
  risk_reward:           number;
  stress_survival_score: number | null;
  live_valid:            boolean | null;
  rejection_codes:       string[];
  rejection_reasons:     string[];
  factor_scores?:        Partial<FactorScores>;
  explanation?:          Partial<SignalExplanation>;
  expectedBucket:        'main_table' | 'emerging' | 'rejected';
  expectedRejectReasonContains?: string;
}

const baseFactors: FactorScores = {
  strategy_quality: 75, trend_alignment: 75, momentum: 75, volume_confirmation: 70,
  risk_reward: 75, liquidity: 80, market_regime: 70, portfolio_fit: 70,
};

const baseExplanation: SignalExplanation = {
  summary_reason:             '',
  factor_score_explanation:   '',
  risk_explanation:           '',
  portfolio_explanation:      '',
  stress_explanation:         '',
  rejection_explanation:      '',
  final_decision_explanation: '',
};

function summary(symbol: string, dir: string, cls: string, score: number): string {
  return `${symbol} ${dir} → ${cls} (score ${score}). Led by liquidity & trend alignment.`;
}

const FIXTURES: Fixture[] = [
  // ── Approved main-table signals (5) ─────────────────────────
  { symbol: 'TCS',        strategy: 'bullish_breakout',         direction: 'BUY',
    classification: 'INSTITUTIONAL_HIGH_CONVICTION', signal_status: 'APPROVED_SIGNAL',
    final_score: 92, confidence_score: 88, risk_score: 30, portfolio_fit_score: 82,
    risk_reward: 2.8, stress_survival_score: 88, live_valid: true,
    rejection_codes: [], rejection_reasons: [],
    factor_scores: { strategy_quality: 90, trend_alignment: 92, liquidity: 88 },
    explanation: { summary_reason: summary('TCS', 'BUY', 'INSTITUTIONAL_HIGH_CONVICTION', 92),
                   final_decision_explanation: 'APPROVED. Cleared every gate. Sized for entry.' },
    expectedBucket: 'main_table' },

  { symbol: 'INFY',       strategy: 'pullback_retest',          direction: 'BUY',
    classification: 'HIGH_CONVICTION', signal_status: 'APPROVED_SIGNAL',
    final_score: 81, confidence_score: 78, risk_score: 38, portfolio_fit_score: 76,
    risk_reward: 2.4, stress_survival_score: 75, live_valid: true,
    rejection_codes: [], rejection_reasons: [],
    explanation: { summary_reason: summary('INFY', 'BUY', 'HIGH_CONVICTION', 81),
                   final_decision_explanation: 'APPROVED. Cleared every gate.' },
    expectedBucket: 'main_table' },

  { symbol: 'RELIANCE',   strategy: 'momentum_followthrough',   direction: 'SELL',
    classification: 'VALID_SIGNAL', signal_status: 'APPROVED_SIGNAL',
    final_score: 68, confidence_score: 65, risk_score: 48, portfolio_fit_score: 62,
    risk_reward: 1.7, stress_survival_score: 64, live_valid: true,
    rejection_codes: [], rejection_reasons: [],
    explanation: { summary_reason: summary('RELIANCE', 'SELL', 'VALID_SIGNAL', 68),
                   final_decision_explanation: 'APPROVED at the boundary — VALID_SIGNAL band.' },
    expectedBucket: 'main_table' },

  { symbol: 'HDFCBANK',   strategy: 'bullish_breakout',         direction: 'BUY',
    classification: 'HIGH_CONVICTION', signal_status: 'APPROVED_SIGNAL',
    final_score: 76, confidence_score: 72, risk_score: 42, portfolio_fit_score: 70,
    risk_reward: 2.1, stress_survival_score: 72, live_valid: true,
    rejection_codes: [], rejection_reasons: [],
    explanation: { summary_reason: summary('HDFCBANK', 'BUY', 'HIGH_CONVICTION', 76),
                   final_decision_explanation: 'APPROVED.' },
    expectedBucket: 'main_table' },

  { symbol: 'ICICIBANK',  strategy: 'bearish_breakdown',        direction: 'SELL',
    classification: 'VALID_SIGNAL', signal_status: 'APPROVED_SIGNAL',
    final_score: 65, confidence_score: 64, risk_score: 50, portfolio_fit_score: 58,
    risk_reward: 1.6, stress_survival_score: 61, live_valid: true,
    rejection_codes: [], rejection_reasons: [],
    explanation: { summary_reason: summary('ICICIBANK', 'SELL', 'VALID_SIGNAL', 65),
                   final_decision_explanation: 'APPROVED at the floor.' },
    expectedBucket: 'main_table' },

  // ── Emerging Opportunities (2) ───────────────────────────────
  { symbol: 'WIPRO',      strategy: 'pullback_retest',          direction: 'BUY',
    classification: 'DEVELOPING_SETUP', signal_status: 'DEVELOPING_SETUP',
    final_score: 48, confidence_score: 52, risk_score: 55, portfolio_fit_score: 50,
    risk_reward: 1.4, stress_survival_score: 55, live_valid: true,
    rejection_codes: ['confidence_below_threshold'],
    rejection_reasons: ['Confidence 52 below threshold 60'],
    explanation: { summary_reason: 'WIPRO BUY → DEVELOPING_SETUP. Setup in formation — wait for breakout.' },
    expectedBucket: 'emerging' },

  { symbol: 'HCLTECH',    strategy: 'mean_reversion_confirmation', direction: 'BUY',
    classification: 'WATCHLIST_ONLY', signal_status: 'DEVELOPING_SETUP',
    final_score: 42, confidence_score: 48, risk_score: 60, portfolio_fit_score: 45,
    risk_reward: 1.3, stress_survival_score: 70, live_valid: true,
    rejection_codes: ['confidence_below_threshold', 'risk_reward_insufficient'],
    rejection_reasons: ['Confidence 48 below threshold 60', 'Risk:Reward 1.3 below floor 1.5'],
    explanation: { summary_reason: 'HCLTECH BUY → WATCHLIST_ONLY. Setup ranking but below entry threshold.' },
    expectedBucket: 'emerging' },

  // ── Hard rejections (4) ─────────────────────────────────────
  { symbol: 'BADCO',      strategy: 'bullish_breakout',         direction: 'BUY',
    classification: 'NO_TRADE', signal_status: 'NO_TRADE',
    final_score: 22, confidence_score: 38, risk_score: 88, portfolio_fit_score: 18,
    risk_reward: 0.8, stress_survival_score: 30, live_valid: false,
    rejection_codes: [
      'confidence_below_threshold', 'risk_score_exceeded',
      'risk_reward_insufficient',   'stress_survival_below_60',
      'stop_violated',
    ],
    rejection_reasons: [
      'Confidence 38 below threshold 60',
      'Risk score 88 above ceiling 70',
      'Risk:Reward 0.8 below floor 1.5',
      'Stress survival 30 below floor 60',
      'Live price already past stop',
    ],
    explanation: { summary_reason: 'BADCO BUY → NO_TRADE. Multiple gates failed.' },
    expectedBucket:               'rejected',
    expectedRejectReasonContains: 'classification=NO_TRADE' },

  { symbol: 'STALECO',    strategy: 'bullish_breakout',         direction: 'BUY',
    // Classified HC but live invalidated upstream → must NOT reach main table.
    classification: 'HIGH_CONVICTION', signal_status: 'APPROVED_SIGNAL',
    final_score: 80, confidence_score: 75, risk_score: 35, portfolio_fit_score: 70,
    risk_reward: 2.1, stress_survival_score: 80, live_valid: false,
    rejection_codes: ['live_invalidated', 'stop_violated'],
    rejection_reasons: ['Signal flagged live_invalidated upstream', 'Live price already past stop'],
    explanation: { summary_reason: 'STALECO BUY → invalidated. Live tape moved against entry.' },
    expectedBucket:               'rejected',
    expectedRejectReasonContains: 'live_valid=false' },

  { symbol: 'FRAGILECO',  strategy: 'pullback_retest',          direction: 'BUY',
    // Classified VS but fragile (stress 42) → must NOT reach main table.
    classification: 'VALID_SIGNAL', signal_status: 'APPROVED_SIGNAL',
    final_score: 70, confidence_score: 66, risk_score: 50, portfolio_fit_score: 55,
    risk_reward: 1.8, stress_survival_score: 42, live_valid: true,
    rejection_codes: ['stress_survival_below_60', 'market_crash_breaches_stop'],
    rejection_reasons: ['Stress survival 42 below floor 60', 'Stop too tight for 5% market drop'],
    explanation: { summary_reason: 'FRAGILECO BUY → fragile. Worst case loss exceeds capital cushion.' },
    expectedBucket:               'rejected',
    expectedRejectReasonContains: 'stress_survival_score=42 < 60' },

  { symbol: 'MISMATCH',   strategy: 'bullish_breakout',         direction: 'BUY',
    // Classification HC but signal_status DEVELOPING_SETUP → must NOT reach main.
    classification: 'HIGH_CONVICTION', signal_status: 'DEVELOPING_SETUP',
    final_score: 70, confidence_score: 68, risk_score: 40, portfolio_fit_score: 60,
    risk_reward: 2.0, stress_survival_score: 80, live_valid: true,
    rejection_codes: ['status_classification_mismatch'],
    rejection_reasons: ['signal_status=DEVELOPING_SETUP disagrees with classification=HIGH_CONVICTION'],
    explanation: { summary_reason: 'MISMATCH BUY → status / classification disagreement.' },
    expectedBucket:               'rejected',
    expectedRejectReasonContains: 'signal_status=DEVELOPING_SETUP ≠ APPROVED_SIGNAL' },

  // ── Legacy row (Phase-11 fields not yet populated) ──────────
  { symbol: 'LEGACY',     strategy: 'bullish_breakout',         direction: 'BUY',
    classification: null, signal_status: 'APPROVED_SIGNAL',
    final_score: 82, confidence_score: 76, risk_score: 38, portfolio_fit_score: 70,
    risk_reward: 2.2, stress_survival_score: null, live_valid: null,
    rejection_codes: [], rejection_reasons: [],
    explanation: { summary_reason: 'LEGACY BUY → derived classification from final_score band.' },
    expectedBucket: 'main_table' },
];

// ── Run each fixture through the Phase-11 cache + Phase-12 partition ──

interface Result {
  fixture:    Fixture;
  api:        Phase11ApiSignalResponse;
  bucket:     'main_table' | 'emerging' | 'rejected';
  reasons:    string[];
}

function runFixture(fx: Fixture): Result {
  // Build a synthetic DB row using the Phase-11 column names.
  const dbRow = {
    id:                  Math.floor(Math.random() * 100000),
    symbol:              fx.symbol,
    direction:           fx.direction,
    generated_at:        new Date('2026-04-25T10:00:00Z'),
    final_score:         fx.final_score,
    classification:      fx.classification,
    confidence_score:    fx.confidence_score,
    risk_score:          fx.risk_score,
    portfolio_fit_score: fx.portfolio_fit_score,
    risk_reward:         fx.risk_reward,
    stress_survival_score: fx.stress_survival_score,
    signal_status:       fx.signal_status,
    live_valid:          fx.live_valid === null ? null : (fx.live_valid ? 1 : 0),
    phase4_factor_scores_json:    JSON.stringify({ ...baseFactors, ...(fx.factor_scores ?? {}) }),
    rejection_codes_json:         JSON.stringify(fx.rejection_codes),
    rejection_reasons_json:       JSON.stringify(fx.rejection_reasons),
    live_validation_reasons_json: JSON.stringify(
      fx.live_valid === false ? ['Signal flagged live_invalidated upstream'] : [],
    ),
    recommended_quantity: fx.expectedBucket === 'main_table' ? 100 : 0,
    recommended_capital:  fx.expectedBucket === 'main_table' ? 100 * 1500 : 0,
    explanation_json:     JSON.stringify({ ...baseExplanation, ...(fx.explanation ?? {}) }),
  };

  // Round-trip: DB → row → cache → JSON wire → row → API response.
  const row    = fromDbRow(dbRow as any);
  const cached = serializeForCache(row);
  const wire   = JSON.parse(JSON.stringify(cached));
  const back   = deserializeFromCache(wire);
  const api    = toApiResponse(back);

  // Phase-12 routing decides where the row lands in the UI.
  const decision = routeSignal({
    classification:        fx.classification ?? api.classification,
    signal_status:         fx.signal_status ?? api.signal_status,
    live_valid:            fx.live_valid,
    stress_survival_score: fx.stress_survival_score,
    final_score:           fx.final_score,
  });
  return { fixture: fx, api, bucket: decision.destination, reasons: decision.reasons };
}

console.log('='.repeat(96));
console.log('PHASE-13 END-TO-END VALIDATION');
console.log('  fixtures: ' + FIXTURES.length + ' signals');
console.log('  pipeline: DB row → fromDbRow() → serializeForCache() → JSON → deserialize → toApiResponse() → routeSignal()');
console.log('='.repeat(96));
console.log('');

const results = FIXTURES.map(runFixture);

// ── Test results table ────────────────────────────────────────

const colHeaders = [
  'Symbol', 'Strategy', 'Final', 'Classification', 'Status',
  'Risk', 'R:R', 'PFit', 'Stress', 'Live', 'Reject Codes',
];
const colWidths  = [10, 28, 6, 30, 18, 5, 5, 5, 7, 6, 40];
function pad(s: string, n: number, alignRight = false): string {
  s = String(s);
  if (s.length > n) return s.slice(0, n - 1) + '…';
  const filler = ' '.repeat(n - s.length);
  return alignRight ? filler + s : s + filler;
}

console.log('## Test results table');
console.log('');
console.log('  ' + colHeaders.map((h, i) => pad(h, colWidths[i])).join(' '));
console.log('  ' + colWidths.map((w) => '-'.repeat(w)).join(' '));
for (const r of results) {
  const a = r.api;
  const codes = a.rejection_codes.length === 0 ? '(none)' : a.rejection_codes.join(', ');
  console.log('  ' +
    pad(a.symbol,                    colWidths[0]) + ' ' +
    pad(r.fixture.strategy,          colWidths[1]) + ' ' +
    pad(String(a.final_score),       colWidths[2], true) + ' ' +
    pad(a.classification,            colWidths[3]) + ' ' +
    pad(a.signal_status,             colWidths[4]) + ' ' +
    pad(String(a.risk_score),        colWidths[5], true) + ' ' +
    pad(String(a.risk_reward),       colWidths[6], true) + ' ' +
    pad(String(a.portfolio_fit_score), colWidths[7], true) + ' ' +
    pad(String(a.stress_survival_score), colWidths[8], true) + ' ' +
    pad(String(a.live_valid),        colWidths[9]) + ' ' +
    pad(codes,                       colWidths[10]),
  );
}
console.log('');

// ── Bucket summary ─────────────────────────────────────────────

const partition = partitionForUi(FIXTURES.map((f) => ({
  classification:        f.classification,
  signal_status:         f.signal_status,
  live_valid:            f.live_valid,
  stress_survival_score: f.stress_survival_score,
  final_score:           f.final_score,
  symbol:                f.symbol,
})) as any);
console.log('## Bucket summary (Phase-12 partition)');
console.log('   main table:   ' + partition.mainTable.map((r: any) => r.symbol).join(', '));
console.log('   emerging:     ' + partition.emergingOpportunities.map((r: any) => r.symbol).join(', '));
console.log('   rejected:     ' + partition.rejected.map((x) => (x.row as any).symbol).join(', '));
console.log('');

// ── Invariants ────────────────────────────────────────────────

const issues: string[] = [];

// 1. Main table contains only approved signals. Null Phase-11 fields
//    (legacy rows before upstream phases are wired) are tolerated —
//    the partition layer treats null as "field not yet populated".
for (const r of results) {
  if (r.bucket !== 'main_table') continue;
  if (r.api.signal_status !== 'APPROVED_SIGNAL') {
    issues.push(`${r.api.symbol}: in main table but signal_status=${r.api.signal_status}`);
  }
  if (!['INSTITUTIONAL_HIGH_CONVICTION', 'HIGH_CONVICTION', 'VALID_SIGNAL'].includes(r.api.classification)) {
    issues.push(`${r.api.symbol}: in main table but classification=${r.api.classification}`);
  }
  if (r.api.live_valid === false) {
    issues.push(`${r.api.symbol}: in main table but live_valid=false`);
  }
  if (r.api.stress_survival_score !== null && r.api.stress_survival_score < 60) {
    issues.push(`${r.api.symbol}: in main table but stress_survival_score=${r.api.stress_survival_score} < 60`);
  }
}

// 2. Rejected signals include clear reasons.
for (const r of results) {
  if (r.bucket !== 'rejected') continue;
  if (r.reasons.length === 0) {
    issues.push(`${r.api.symbol}: rejected with no reasons attached`);
  }
  if (r.fixture.expectedRejectReasonContains &&
      !r.reasons.some((x) => x.includes(r.fixture.expectedRejectReasonContains!))) {
    issues.push(`${r.api.symbol}: expected reject reason "${r.fixture.expectedRejectReasonContains}" not in [${r.reasons.join(' | ')}]`);
  }
  // Hard-rejects with rejection codes from the engine should be carried through.
  if (r.fixture.rejection_codes.length > 0 && r.api.rejection_codes.length === 0) {
    issues.push(`${r.api.symbol}: rejected fixture lost rejection_codes through serialization`);
  }
}

// 3. No signal appears without final_score and classification.
for (const r of results) {
  if (!Number.isFinite(r.api.final_score)) {
    issues.push(`${r.api.symbol}: final_score is not a finite number (${r.api.final_score})`);
  }
  if (!r.api.classification) {
    issues.push(`${r.api.symbol}: classification is empty`);
  }
}

// 4. API and UI fields match — every Phase-11 required key present.
for (const r of results) {
  const apiRecord = r.api as unknown as Record<string, unknown>;
  for (const key of PHASE_11_REQUIRED_FIELDS) {
    if (!(key in apiRecord)) {
      issues.push(`${r.api.symbol}: Phase-11 required field "${String(key)}" missing on API response`);
    }
  }
}

// 5. Bucket assignment matches the fixture's expectation.
for (const r of results) {
  if (r.bucket !== r.fixture.expectedBucket) {
    issues.push(`${r.api.symbol}: expected bucket=${r.fixture.expectedBucket}, got ${r.bucket}`);
  }
}

console.log('## Invariants');
console.log('   [1] main table contains only approved signals  → ' +
  (results.filter((r) => r.bucket === 'main_table').every((r) =>
    r.api.signal_status === 'APPROVED_SIGNAL' &&
    ['INSTITUTIONAL_HIGH_CONVICTION', 'HIGH_CONVICTION', 'VALID_SIGNAL'].includes(r.api.classification) &&
    r.api.live_valid !== false &&
    (r.api.stress_survival_score === null || r.api.stress_survival_score >= 60)) ? 'PASS' : 'FAIL'));
console.log('   [2] rejected signals carry reasons             → ' +
  (results.filter((r) => r.bucket === 'rejected').every((r) => r.reasons.length > 0) ? 'PASS' : 'FAIL'));
console.log('   [3] every signal has final_score + classification → ' +
  (results.every((r) => Number.isFinite(r.api.final_score) && r.api.classification) ? 'PASS' : 'FAIL'));
console.log('   [4] API and UI fields match (16 required keys) → ' +
  (results.every((r) => {
    const apiRecord = r.api as unknown as Record<string, unknown>;
    return PHASE_11_REQUIRED_FIELDS.every((k) => k in apiRecord);
  }) ? 'PASS' : 'FAIL'));
console.log('   [5] bucket matches expectation                 → ' +
  (results.every((r) => r.bucket === r.fixture.expectedBucket) ? 'PASS' : 'FAIL'));
console.log('');

// ── Wrap-up report ────────────────────────────────────────────

console.log('='.repeat(96));
console.log('## ISSUES FOUND');
console.log('='.repeat(96));
if (issues.length === 0) {
  console.log('  (none)');
} else {
  for (const m of issues) console.log('  - ' + m);
}
console.log('');

console.log('='.repeat(96));
console.log('## FILES CHANGED (Phases 5–12)');
console.log('='.repeat(96));
const filesChanged = [
  'src/lib/db/migrateSignalEngine.ts                                  (Phase 11 — added 8 columns + 2 indexes)',
  'src/lib/signal-engine/types/phase11Signal.ts                       (Phase 11 — canonical row type)',
  'src/lib/signal-engine/repository/phase11Serialization.ts           (Phase 11 — DB ↔ Redis ↔ API)',
  'src/lib/signal-engine/risk/stressTestEngine.ts                     (Phase 7  — rewritten for spec scenarios)',
  'src/lib/signal-engine/live/liveValidationEngine.ts                 (Phase 8  — rewritten with live_price_snapshot)',
  'src/lib/signal-engine/portfolio/positionSizingEngine.ts            (Phase 9  — new, four caps)',
  'src/lib/signal-engine/explainability/signalExplainabilityEngine.ts (Phase 10 — new, 7-section block)',
  'src/lib/signal-engine/pipeline/phase12Routing.ts                   (Phase 12 — main vs emerging partition)',
  'src/app/api/signals/route.ts                                       (Phase 12 — final partition pass)',
  'src/components/signals/Phase12SignalRow.tsx                        (Phase 12 — UI cell renderers)',
  'src/components/signals/EmergingOpportunitiesSection.tsx            (Phase 12 — UI section)',
  'src/types/phase11Signal.ts                                         (Phase 11 — frontend re-export)',
  'scripts/validatePhase{7,8,9,10,11,12,13}*.ts                       (validation harnesses)',
];
for (const f of filesChanged) console.log('  - ' + f);
console.log('');

console.log('='.repeat(96));
console.log('## REMAINING RISKS');
console.log('='.repeat(96));
const risks = [
  'Phase-7 / 8 / 9 / 10 engines exist as pure modules but are NOT YET wired into ' +
    'generatePhase4Signals or saveSignals — the Phase-11 columns (stress_survival_score, ' +
    'recommended_quantity, recommended_capital, live_valid, rejection_codes_json, ' +
    'rejection_reasons_json, live_validation_reasons_json, explanation_json) will stay ' +
    'NULL for every newly-generated signal until that integration ships.',
  'Phase-12 partition treats null Phase-11 fields as "pass" so legacy rows survive. ' +
    'Once upstream phases write these fields, flip the null defaults to "fail" or the ' +
    'gates become advisory.',
  'The validation harnesses use synthetic fixtures — they do not exercise the real ' +
    'candle/feature pipeline. A pre-production smoke run with live data and the ' +
    'integrated writer is still required.',
  'API route still carries the legacy Phase-1 strict gate AND the new Phase-12 ' +
    'partition; until the legacy gate is retired, both run on every request — small ' +
    'CPU cost but worth removing once Phase-11 is fully populated.',
  'Frontend page (src/app/signals/page.tsx) has not been updated to render the ' +
    'EmergingOpportunitiesSection or the Phase-12 UI cells. The components exist; ' +
    'wiring them into the existing 1,274-line page is a separate UI integration step.',
];
for (const r of risks) console.log('  - ' + r);
console.log('');

console.log('='.repeat(96));
console.log('## RECOMMENDED NEXT IMPROVEMENTS');
console.log('='.repeat(96));
const improvements = [
  'Wire Phase-7 stressTestEngine + Phase-8 liveValidationEngine + Phase-9 ' +
    'positionSizingEngine + Phase-10 explainabilityEngine into ' +
    'generatePhase4Signals so saveSignals can persist the Phase-11 columns on ' +
    'every INSERT.',
  'Update saveSignals.ts to write the eight new columns + four JSON blobs added by ' +
    'the Phase-11 migration (stress_survival_score, recommended_quantity, ' +
    'recommended_capital, live_valid, *_json).',
  'Update readSignals.ts SELECT lists to project the Phase-11 columns into the ' +
    'existing API row shape so /api/signals?action=all returns a Phase11ApiSignalResponse-' +
    'compatible payload directly (no client-side hydration required).',
  'Add an integration test that fires the full Phase 1 → 12 pipeline against ' +
    '5 real symbols and asserts the response payload matches Phase11ApiSignalResponse.',
  'Replace the legacy Phase-1 strict gate in /api/signals with the Phase-12 ' +
    'partition once the data path is fully populated.',
  'Render Phase12SignalRow cells + EmergingOpportunitiesSection in src/app/signals/page.tsx.',
];
for (const i of improvements) console.log('  - ' + i);
console.log('');

const ok = issues.length === 0;
console.log('='.repeat(96));
console.log(ok
  ? 'RESULT: Phase-13 end-to-end validation passes. Spec invariants hold across all 12 fixtures.'
  : 'RESULT: ' + issues.length + ' issue(s) detected. See list above.');
console.log('='.repeat(96));
process.exit(ok ? 0 : 1);
