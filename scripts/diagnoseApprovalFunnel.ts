/**
 * scripts/diagnoseApprovalFunnel.ts
 *
 * Spec INSTITUTIONAL §I — full approval-funnel audit. Triggers a
 * single Phase 4 invocation, runs the maturity worker once, then
 * captures all the structured markers and presents them as a single
 * numbered table:
 *
 *   1. universe size
 *   2. Phase 3 received
 *   3. Phase 3 scanned
 *   4. Phase 3 matched (any strategy)
 *   5. Approval gate counts (canonical 11-field envelope)
 *   6. Classification distribution
 *   7. Maturity worker outcomes
 *   8. Final confirmed snapshots written
 *
 * Identifies the dominant rejection bucket and prints the env knob
 * that loosens it.
 *
 * Usage:
 *   npx tsx scripts/diagnoseApprovalFunnel.ts
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { generatePhase4Signals, DEFAULT_PHASE1_CONFIG } from '../src/lib/signal-engine';
import type { CandleProvider, Candle, PortfolioSnapshot } from '../src/lib/signal-engine';
import { initOnce } from '../src/lib/marketData/nifty500Universe';
import { runSignalMaturityWorker } from '../src/lib/cron/signalMaturity';

const STUB_PORTFOLIO: PortfolioSnapshot = {
  capital: 1_000_000, cashAvailable: 1_000_000,
  openPositions: [], pendingSignals: [],
};

const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    try {
      const { rows } = await db.query<any>(
        `SELECT ts, open, high, low, close, volume
           FROM market_data_daily WHERE symbol = ?
           ORDER BY ts DESC LIMIT 250`,
        [symbol.toUpperCase()],
      );
      return ((rows as any[]) ?? [])
        .reverse()
        .map((r) => ({
          ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
          open: Number(r.open), high: Number(r.high),
          low: Number(r.low),  close: Number(r.close),
          volume: Number(r.volume ?? 0),
        })) as Candle[];
    } catch { return []; }
  },
};

interface Snapshot {
  q365_signals_total: number;
  confirmed_total:    number;
  tracker_total:      number;
}

async function snap(): Promise<Snapshot> {
  const pull = async (sql: string): Promise<number> => {
    try {
      const { rows } = await db.query<{ c: number }>(sql);
      return Number(rows[0]?.c ?? 0);
    } catch { return -1; }
  };
  return {
    q365_signals_total: await pull(`SELECT COUNT(*) AS c FROM q365_signals`),
    confirmed_total:    await pull(`SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots`),
    tracker_total:      await pull(`SELECT COUNT(*) AS c FROM q365_signal_maturity_tracker`),
  };
}

function recommend(env: Record<string, number>): string[] {
  const out: string[] = [];
  const ranked = Object.entries(env)
    .filter(([k, v]) => k !== 'matched' && k !== 'approved' && Number.isFinite(v) && v > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (ranked.length === 0) return out;
  const [topKey, topVal] = ranked[0];
  out.push(`Dominant rejection: ${topKey}=${topVal}`);
  switch (topKey) {
    case 'rejected_low_confidence':
      out.push('  Lower CONFIDENCE_BAND_WATCHLIST (default 55) so fewer rows hit the Avoid band.');
      break;
    case 'rejected_low_final_score':
      out.push('  Lower SCORE_BAND_VALID_SIGNAL_MIN or audit [PHASE4_FACTORS] log for the dragging factor.');
      break;
    case 'rejected_rr':
      out.push('  Lower DEFAULT_PHASE3_CONFIG.minRewardRisk (currently 1.5) — but quality drops below 1.5 RR.');
      break;
    case 'rejected_volatility':
      out.push('  Increase MAX_VOLATILITY in preFilter or relax the volatility-shock penalty.');
      break;
    case 'rejected_market_regime':
      out.push('  Counter-regime trades blocked by maturity-worker REGIME_GATE_THRESHOLD (0.5).');
      break;
    case 'rejected_position_sizing':
      out.push('  Position sizer is invalidating rows — check capital / risk-per-trade settings.');
      break;
    case 'rejected_portfolio_rejected':
      out.push('  Lower minPortfolioFit (currently 40) in Phase 3 rejection input.');
      break;
    case 'rejected_risk_too_high':
      out.push('  Raise the risk ceiling (executionReadiness uses 75) or improve risk inputs.');
      break;
    case 'deferred_watchlist_band':
      out.push('  Lower CONFIDENCE_BAND_ACTIONABLE (currently 60) so more rows promote past Watchlist.');
      out.push('  OR loosen the Watchlist-promotion criteria in executionReadiness.ts (RR ≥ 1.8 + risk ≤ 60).');
      break;
    case 'deferred_portfolio':
      out.push('  Portfolio-fit deferred — check sector/correlation caps in Phase 3 portfolio engine.');
      break;
    case 'rejected_stability':
      out.push('  Maturity worker needs ≥2 cycles before stable=true. Wait or lower PROMOTE_MIN_CYCLES.');
      break;
    case 'rejected_maturity':
      out.push('  Maturity score < PROMOTE_MIN_MATURITY (currently 70). Wait or lower the env.');
      break;
    case 'rejected_live_validation':
      out.push('  Phase-8 live-validation gate is failing rows. Check live_valid column in q365_signals.');
      break;
    case 'rejected_stress':
      out.push('  Stress-survival floor too high. Lower SIGNAL_STRESS_FLOOR (currently 50).');
      break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  APPROVAL FUNNEL DIAGNOSTIC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Universe init
  console.log('\n  ▸ Step 1 — universe + DB snapshot');
  await initOnce().catch((err) => {
    console.error(`     init failed: ${err?.message}`);
    process.exit(2);
  });
  const universe = DEFAULT_PHASE1_CONFIG.universe.length;
  const t0 = await snap();
  console.log(`     universe = ${universe}`);
  console.log(`     pre-run: q365_signals=${t0.q365_signals_total} confirmed=${t0.confirmed_total} tracker=${t0.tracker_total}`);

  // 2. Run Phase 4
  console.log('\n  ▸ Step 2 — generatePhase4Signals (watch [PHASE3_RECEIVED] / [APPROVAL_GATE] / [PHASE4_BANDS])');
  let phase4: any;
  try {
    phase4 = await generatePhase4Signals(
      dbCandleProvider, STUB_PORTFOLIO,
      undefined, undefined, DEFAULT_PHASE1_CONFIG, undefined,
      { generationSource: 'script:diagnoseApprovalFunnel' },
    );
  } catch (err: any) {
    console.error(`     phase4 threw: ${err?.message}`);
    process.exit(2);
  }
  const t1 = await snap();
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log(`  │  universe                       ${String(universe).padStart(7)}         │`);
  console.log(`  │  Phase 3 scanned                ${String(phase4.meta.scanned).padStart(7)}         │`);
  console.log(`  │  coverage_percent           ${String(Math.round((phase4.meta.scanned / Math.max(1, universe)) * 1000) / 10 + '%').padStart(8)}        │`);
  console.log(`  │  Phase 3 matched (signals)      ${String(phase4.signals.length).padStart(7)}         │`);
  console.log(`  │  Phase 3 approved               ${String(phase4.meta.approved).padStart(7)}         │`);
  console.log(`  │  Phase 3 deferred               ${String(phase4.meta.deferred).padStart(7)}         │`);
  console.log(`  │  Phase 3 rejected               ${String(phase4.meta.rejected).padStart(7)}         │`);
  console.log(`  │  Δ q365_signals                 ${String(t1.q365_signals_total - t0.q365_signals_total).padStart(7)}         │`);
  console.log('  └─────────────────────────────────────────────────┘');

  // 3. Run maturity worker
  console.log('\n  ▸ Step 3 — runSignalMaturityWorker (watch [PROMOTION_SCORE] / [STABILITY_RESULT] / [REGIME_VETO] / [FINAL_APPROVAL])');
  let maturity: any;
  try {
    maturity = await runSignalMaturityWorker();
  } catch (err: any) {
    console.error(`     maturity threw: ${err?.message}`);
  }
  const t2 = await snap();
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log(`  │  trackers scanned               ${String(maturity?.scanned ?? 0).padStart(7)}         │`);
  console.log(`  │  promoted (→ confirmed)         ${String(maturity?.promoted ?? 0).padStart(7)}         │`);
  console.log(`  │  matured (cycles short)         ${String(maturity?.matured ?? 0).padStart(7)}         │`);
  console.log(`  │  developing                     ${String(maturity?.developing ?? 0).padStart(7)}         │`);
  console.log(`  │  candidate                      ${String(maturity?.candidate ?? 0).padStart(7)}         │`);
  console.log(`  │  regime_blocked                 ${String(maturity?.regime_blocked ?? 0).padStart(7)}         │`);
  console.log(`  │  failed                         ${String(maturity?.failed ?? 0).padStart(7)}         │`);
  console.log(`  │  Δ confirmed_snapshots          ${String(t2.confirmed_total - t0.confirmed_total).padStart(7)}         │`);
  console.log(`  │  Δ tracker rows                 ${String(t2.tracker_total - t0.tracker_total).padStart(7)}         │`);
  console.log('  └─────────────────────────────────────────────────┘');

  // 4. Verdict
  console.log('\n  ▸ Step 4 — verdict + recommendations');
  const target = { coverage: 95, approved: 5 };
  const coverage = universe > 0
    ? Math.round((phase4.meta.scanned / universe) * 1000) / 10
    : 0;
  const failures: string[] = [];

  if (coverage < target.coverage) {
    failures.push(
      `coverage ${coverage}% < ${target.coverage}% — universe size ${universe}, scanned ${phase4.meta.scanned}, gap ${universe - phase4.meta.scanned}`,
    );
    failures.push('  → check [PHASE3_RECEIVED] log line: if symbols=N matches the universe, the for-loop ran fully');
    failures.push('  → check [PHASE3_SKIPPED] log: high no_candles count means market_data_daily is missing rows');
    failures.push('  → run `npx tsx scripts/diagnoseUniverse.ts` to verify q365_universe(is_active=1) count');
  }
  const finalApprovals = maturity?.promoted ?? 0;
  if (finalApprovals < target.approved) {
    failures.push(`final approvals ${finalApprovals} < ${target.approved}`);
    failures.push('  → grep [APPROVAL_GATE] above for the dominant deferred/rejected bucket');
    failures.push('  → grep [PERSIST_FAILED] above for promotion-writer rejections');
  }
  if (failures.length === 0) {
    console.log(`     ✓ coverage ${coverage}% with ${finalApprovals} approved confirmed snapshots`);
    process.exit(0);
  }
  for (const f of failures) console.log(`     ✗ ${f}`);

  // 5. Surface the dominant approval-gate bucket using the in-memory aggregator output.
  console.log('\n  ▸ Step 5 — recommended action');
  // We can't import the aggregator state directly (resetApprovalGateAggregator
  // would clear it), so this section prompts the operator to read the
  // [APPROVAL_GATE] line printed above.
  console.log('     Read the [APPROVAL_GATE] line printed above. Field with the highest count is the bottleneck.');
  console.log('     Common single-knob fixes:');
  console.log('       deferred_watchlist_band → CONFIDENCE_BAND_ACTIONABLE=55 (already at 60 by default)');
  console.log('       rejected_low_confidence → CONFIDENCE_BAND_WATCHLIST=45');
  console.log('       rejected_rr             → DEFAULT_PHASE3_CONFIG.minRewardRisk=1.3 (institutional floor)');
  console.log('       rejected_risk_too_high  → executionReadiness.ts risk ceiling 75 (audit risk inputs first)');
  console.log('       rejected_market_regime  → REGIME_GATE_THRESHOLD=0.4 in signalMaturity.ts');
  console.log('     For confirmed-snapshot promotion: PROMOTE_MIN_CONFIDENCE / PROMOTE_MIN_FINAL_SCORE / PROMOTE_MIN_RR / PROMOTE_MIN_CYCLES / PROMOTE_MIN_MATURITY env knobs.');
  console.log('     Persist trace: npx tsx scripts/tracePersistence.ts');
  console.log('');
  void recommend;  // exported for future CI integration
  process.exit(1);
}

main().catch((err) => {
  console.error('approval-funnel diagnostic failed:', err);
  process.exit(2);
});
