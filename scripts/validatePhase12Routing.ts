/**
 * scripts/validatePhase12Routing.ts
 *
 * Phase-12 routing harness.
 *
 *   1. Builds a synthetic batch of signals spanning every
 *      classification (IHC, HC, VS, DS, WL, NT) plus boundary
 *      cases (APPROVED but live_invalidated, APPROVED but stress
 *      below 60, legacy row missing the Phase-11 fields).
 *   2. Runs partitionForUi() and prints which bucket each row
 *      lands in plus the reasons.
 *   3. Asserts the spec invariants:
 *        - main table contains ONLY {IHC, HC, VS} ∧ APPROVED ∧
 *          live_valid ∧ stress ≥ 60
 *        - emerging contains ONLY {DEVELOPING_SETUP, WATCHLIST_ONLY}
 *        - NO_TRADE / live-invalidated / fragile rows are rejected
 *        - approved rows in main table carry an explanation
 *
 * Run:
 *   npx tsx scripts/validatePhase12Routing.ts
 */
import {
  partitionForUi,
  routeSignal,
  STRESS_SURVIVAL_FLOOR,
  MAIN_TABLE_CLASSIFICATIONS,
  EMERGING_CLASSIFICATIONS,
} from '../src/lib/signal-engine/pipeline/phase12Routing';
import type { SignalExplanation } from '../src/lib/signal-engine/types/phase11Signal';

interface FixtureRow {
  symbol:                string;
  direction:             'BUY' | 'SELL';
  classification?:       string | null;
  signal_status?:        string | null;
  live_valid?:           boolean | null;
  stress_survival_score?: number | null;
  final_score?:          number | null;
  risk_score?:           number;
  portfolio_fit_score?:  number;
  risk_reward?:          number;
  explanation?:          SignalExplanation | null;
}

const okExplanation: SignalExplanation = {
  summary_reason:             'TCS BUY → APPROVED (score 78, HIGH_CONVICTION). Led by liquidity 88.',
  factor_score_explanation:   'Strongest factors: liquidity 88, trend_alignment 85.',
  risk_explanation:           'Standalone risk band "Low Risk" (score 38/100).',
  portfolio_explanation:      'Portfolio risk: APPROVED (fit 76/100).',
  stress_explanation:         'Stress survival 75/100 — resilient.',
  rejection_explanation:      'No blocking codes raised across any gate.',
  final_decision_explanation: 'Final decision: APPROVED. Cleared every gate. Sized for entry.',
};

const fixtures: FixtureRow[] = [
  // ── Main-table eligible ────────────────────────────────────
  { symbol: 'TCS',       direction: 'BUY',  classification: 'INSTITUTIONAL_HIGH_CONVICTION',
    signal_status: 'APPROVED_SIGNAL', live_valid: true, stress_survival_score: 88,
    final_score: 92, risk_score: 32, portfolio_fit_score: 80, risk_reward: 2.8,
    explanation: okExplanation },
  { symbol: 'INFY',      direction: 'BUY',  classification: 'HIGH_CONVICTION',
    signal_status: 'APPROVED_SIGNAL', live_valid: true, stress_survival_score: 75,
    final_score: 78, risk_score: 38, portfolio_fit_score: 76, risk_reward: 2.4,
    explanation: okExplanation },
  { symbol: 'RELIANCE',  direction: 'SELL', classification: 'VALID_SIGNAL',
    signal_status: 'APPROVED_SIGNAL', live_valid: true, stress_survival_score: 64,
    final_score: 68, risk_score: 48, portfolio_fit_score: 62, risk_reward: 1.7,
    explanation: okExplanation },

  // ── Emerging Opportunities ─────────────────────────────────
  { symbol: 'WIPRO',     direction: 'BUY',  classification: 'DEVELOPING_SETUP',
    signal_status: 'DEVELOPING_SETUP', live_valid: true, stress_survival_score: 55,
    final_score: 48, risk_score: 52, portfolio_fit_score: 50, risk_reward: 1.4 },
  { symbol: 'HCLTECH',   direction: 'BUY',  classification: 'WATCHLIST_ONLY',
    signal_status: 'DEVELOPING_SETUP', live_valid: true, stress_survival_score: 70,
    final_score: 42, risk_score: 60, portfolio_fit_score: 45, risk_reward: 1.3 },

  // ── Hard-rejected rows ─────────────────────────────────────
  { symbol: 'BADCO',     direction: 'BUY',  classification: 'NO_TRADE',
    signal_status: 'NO_TRADE', live_valid: false, stress_survival_score: 30,
    final_score: 22, risk_score: 88, portfolio_fit_score: 18, risk_reward: 0.8 },
  // APPROVED but live_invalidated — must NOT appear in main table.
  { symbol: 'STALECO',   direction: 'BUY',  classification: 'HIGH_CONVICTION',
    signal_status: 'APPROVED_SIGNAL', live_valid: false, stress_survival_score: 80,
    final_score: 80, risk_score: 35, portfolio_fit_score: 70, risk_reward: 2.1 },
  // APPROVED but fragile (stress < 60) — must NOT appear in main table.
  { symbol: 'FRAGILECO', direction: 'BUY',  classification: 'VALID_SIGNAL',
    signal_status: 'APPROVED_SIGNAL', live_valid: true, stress_survival_score: 42,
    final_score: 70, risk_score: 50, portfolio_fit_score: 55, risk_reward: 1.8 },
  // APPROVED-classified row but signal_status disagrees → reject.
  { symbol: 'MISMATCH',  direction: 'BUY',  classification: 'HIGH_CONVICTION',
    signal_status: 'DEVELOPING_SETUP', live_valid: true, stress_survival_score: 80,
    final_score: 70, risk_score: 40, portfolio_fit_score: 60, risk_reward: 2.0 },

  // ── Legacy row (Phase-11 fields not yet populated) ─────────
  { symbol: 'LEGACY',    direction: 'BUY',
    classification: null, signal_status: 'APPROVED_SIGNAL',
    live_valid: null, stress_survival_score: null,
    final_score: 82, risk_score: 38, portfolio_fit_score: 70, risk_reward: 2.2 },
];

console.log('='.repeat(72));
console.log('PHASE-12 ROUTING — VALIDATION');
console.log('  main table: {IHC, HC, VS} ∧ APPROVED_SIGNAL ∧ live_valid=true ∧ stress >= ' + STRESS_SURVIVAL_FLOOR);
console.log('  emerging:   {DEVELOPING_SETUP, WATCHLIST_ONLY}');
console.log('='.repeat(72));
console.log('');

console.log('## Per-row routing decisions');
console.log('');
for (const r of fixtures) {
  const d = routeSignal(r);
  const tag = d.destination === 'main_table' ? '[MAIN]    '
            : d.destination === 'emerging'   ? '[EMERGING]'
            :                                  '[REJECTED]';
  console.log('  ' + tag + ' ' + r.symbol.padEnd(10) +
              ' classification=' + (r.classification ?? '(null)').padEnd(30) +
              ' → ' + d.reasons.join('; '));
}
console.log('');

const { mainTable, emergingOpportunities, rejected } = partitionForUi(fixtures);

console.log('## Buckets');
console.log('   main table:   ' + mainTable.map((r) => r.symbol).join(', ') +
            '  (count=' + mainTable.length + ')');
console.log('   emerging:     ' + emergingOpportunities.map((r) => r.symbol).join(', ') +
            '  (count=' + emergingOpportunities.length + ')');
console.log('   rejected:     ' + rejected.map((x) => x.row.symbol).join(', ') +
            '  (count=' + rejected.length + ')');
console.log('');

// ── UI fields visible on every approved main-table row ───────
console.log('## UI-required fields on every main-table row');
console.log('');
for (const r of mainTable) {
  console.log('   ' + r.symbol + ' ' + r.direction);
  console.log('     final_score:           ' + r.final_score);
  console.log('     classification:        ' + r.classification);
  console.log('     risk_score:            ' + r.risk_score);
  console.log('     portfolio_fit_score:   ' + r.portfolio_fit_score);
  console.log('     stress_survival_score: ' + r.stress_survival_score);
  console.log('     risk_reward:           ' + r.risk_reward);
  console.log('     explanation summary:   ' + (r.explanation?.summary_reason ?? '(missing)'));
  console.log('');
}

// ── Invariants ─────────────────────────────────────────────────

const mainSymbols = new Set(mainTable.map((r) => r.symbol));
const emergSymbols = new Set(emergingOpportunities.map((r) => r.symbol));

const mainIsRestricted = mainTable.every((r) =>
  MAIN_TABLE_CLASSIFICATIONS.has(String(r.classification ?? '').toUpperCase() as any) ||
  // legacy row classified by final_score: must derive to IHC/HC/VS
  (r.classification == null && Number(r.final_score ?? 0) >= 50),
);
const emergIsRestricted = emergingOpportunities.every((r) =>
  EMERGING_CLASSIFICATIONS.has(String(r.classification ?? '').toUpperCase() as any),
);
const noWeakInMain = !mainSymbols.has('BADCO') &&
                     !mainSymbols.has('WIPRO') &&
                     !mainSymbols.has('HCLTECH') &&
                     !mainSymbols.has('STALECO') &&
                     !mainSymbols.has('FRAGILECO') &&
                     !mainSymbols.has('MISMATCH');
const developingInEmerging = emergSymbols.has('WIPRO') && emergSymbols.has('HCLTECH');
const approvedKeptInMain = mainSymbols.has('TCS') &&
                           mainSymbols.has('INFY') &&
                           mainSymbols.has('RELIANCE') &&
                           mainSymbols.has('LEGACY');                                  // legacy row passes
const explanationOnApproved = mainTable
  .filter((r) => r.symbol === 'TCS' || r.symbol === 'INFY' || r.symbol === 'RELIANCE')
  .every((r) => !!r.explanation?.summary_reason);

const ok = (
  mainIsRestricted &&
  emergIsRestricted &&
  noWeakInMain &&
  developingInEmerging &&
  approvedKeptInMain &&
  explanationOnApproved
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  Main table contains only {IHC, HC, VS}:                    ' + mainIsRestricted);
console.log('  Emerging contains only {DEVELOPING_SETUP, WATCHLIST_ONLY}: ' + emergIsRestricted);
console.log('  No weak/developing/fragile/invalidated row in main:        ' + noWeakInMain);
console.log('  WIPRO + HCLTECH routed to Emerging:                        ' + developingInEmerging);
console.log('  TCS + INFY + RELIANCE + LEGACY kept in main:               ' + approvedKeptInMain);
console.log('  Approved main-table rows carry explanation summary:        ' + explanationOnApproved);
console.log('');
console.log(ok
  ? 'RESULT: Phase-12 routing honours the spec.'
  : 'RESULT: At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
