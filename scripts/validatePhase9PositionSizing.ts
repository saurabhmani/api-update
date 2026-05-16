/**
 * scripts/validatePhase9PositionSizing.ts
 *
 * Phase-9 validation harness for the position sizing engine.
 *
 * Exercises one fixture per binding cap:
 *   - sample calculation, base sizing wins (risk_based)
 *   - liquidity cap binds
 *   - single-stock cap binds
 *   - sector cap binds
 *   - total-portfolio-risk cap binds
 *   - risk-gate failure → quantity 0
 *
 * Run:
 *   npx tsx scripts/validatePhase9PositionSizing.ts
 */
import {
  calculatePositionSize,
  type PositionSizingInput,
  type PositionSizingResult,
} from '../src/lib/signal-engine/portfolio/positionSizingEngine';

function dump(label: string, input: PositionSizingInput): PositionSizingResult {
  const r = calculatePositionSize(input);
  console.log('── ' + label);
  console.log('   symbol:               ' + r.symbol + ' (' + r.direction + ')');
  console.log('   recommended_quantity: ' + r.recommended_quantity);
  console.log('   recommended_capital:  ' + r.recommended_capital);
  console.log('   risk_amount:          ' + r.risk_amount);
  console.log('   sizing_method:        ' + r.sizing_method);
  console.log('   exposure_after_trade:');
  console.log('     symbol_exposure:          ' + r.exposure_after_trade.symbol_exposure +
              ' (' + r.exposure_after_trade.symbol_exposure_pct + '%)');
  console.log('     sector_exposure:          ' + r.exposure_after_trade.sector_exposure +
              ' (' + r.exposure_after_trade.sector_exposure_pct + '%)');
  console.log('     total_portfolio_risk:     ' + r.exposure_after_trade.total_portfolio_risk +
              ' (' + r.exposure_after_trade.total_portfolio_risk_pct + '%)');
  console.log('   sizing_warnings:');
  if (r.sizing_warnings.length === 0) console.log('     (none)');
  for (const w of r.sizing_warnings) console.log('     - ' + w);
  console.log('');
  return r;
}

console.log('='.repeat(72));
console.log('PHASE-9 POSITION SIZING ENGINE — VALIDATION');
console.log('='.repeat(72));
console.log('');

// ── Shared base — 50L capital, 1% per-trade risk ───────────────
const base: PositionSizingInput = {
  symbol:                    'TCS',
  sector:                    'IT',
  direction:                 'BUY',
  entryPrice:                1500,
  stopLoss:                  1460,                //  ₹40 risk per share
  portfolioCapital:          5_000_000,           //  ₹50,00,000
  riskPerTradePct:           1.0,                 //  → ₹50,000 risk budget
  maxLiquidityCapital:       1_000_000,           //  ₹10L from ADV
  maxSingleStockPct:         10,                  //  ≤ ₹5L per name
  maxSectorPct:              25,                  //  ≤ ₹12.5L per sector
  maxTotalPortfolioRiskPct:  8,                   //  ≤ ₹4L total open risk
  currentSymbolExposure:     0,
  currentSectorExposure:     0,
  currentTotalPortfolioRisk: 0,
  riskGatePassed:            true,
};

// ── 1. SAMPLE CALCULATION — risk_based wins ────────────────────
//    base = floor(50,000 / 40) = 1,250 shares, capital = 18,75,000.
//    At entry 1500 / risk 40 the gross-to-risk ratio is 37.5×, so
//    the default 10 % single-stock cap (5L) clips well before the
//    base size. Loosen the gross caps for the clean demo.
const sample = dump('SAMPLE — base risk_based path wins', {
  ...base,
  maxLiquidityCapital: 5_000_000,
  maxSingleStockPct:   50,
  maxSectorPct:        50,
});

// ── 2. LIQUIDITY cap binds ─────────────────────────────────────
//    Cap at ₹2L → floor(200,000 / 1500) = 133 shares; tighter than
//    the 10 % single-stock cap (333 shares).
const liq = dump('LIQUIDITY-CAPPED — ADV-based cap of ₹2L', {
  ...base,
  maxLiquidityCapital: 200_000,
});

// ── 3. SINGLE-STOCK cap binds (already partly held) ────────────
const stock = dump('SINGLE-STOCK-CAPPED — ₹4L already in TCS', {
  ...base,
  currentSymbolExposure: 400_000,                 //  remaining = ₹1L → 66 shares
});

// ── 4. SECTOR cap binds (already heavy in IT) ──────────────────
const sector = dump('SECTOR-CAPPED — ₹12L already deployed in IT', {
  ...base,
  currentSectorExposure: 1_200_000,               //  remaining = ₹50k → 33 shares
});

// ── 5. TOTAL-PORTFOLIO-RISK cap binds ──────────────────────────
const totalRisk = dump('TOTAL-RISK-CAPPED — ₹3.95L already at risk', {
  ...base,
  currentTotalPortfolioRisk: 395_000,             //  remaining risk = ₹5k → 125 shares
});

// ── 6. RISK GATE FAILURE — no position sized ──────────────────
const gated = dump('GATE-BLOCKED — upstream risk gate failed', {
  ...base,
  riskGatePassed:  false,
  riskGateReasons: ['stress_survival_below_60', 'sector_overexposure'],
});

// ── Invariants ─────────────────────────────────────────────────
const ok = (
  // Sample uses the formula: floor((capital × pct/100) / |entry-stop|)
  //   = floor((5,000,000 × 0.01) / 40) = 1,250
  sample.recommended_quantity === 1250 &&
  sample.sizing_method === 'risk_based' &&
  sample.recommended_capital === 1_875_000 &&
  sample.risk_amount === 50_000 &&

  liq.sizing_method === 'liquidity_capped' &&
  liq.recommended_quantity === Math.floor(200_000 / 1500) &&          // 133

  stock.sizing_method === 'single_stock_capped' &&
  stock.recommended_quantity === Math.floor((500_000 - 400_000) / 1500) && // 66

  sector.sizing_method === 'sector_capped' &&
  sector.recommended_quantity === Math.floor((1_250_000 - 1_200_000) / 1500) && // 33

  totalRisk.sizing_method === 'total_risk_capped' &&
  totalRisk.recommended_quantity === Math.floor((400_000 - 395_000) / 40) &&   // 125

  // Risk-gate failure → no position, method 'gate_blocked'.
  gated.sizing_method === 'gate_blocked' &&
  gated.recommended_quantity === 0 &&
  gated.recommended_capital === 0 &&
  gated.risk_amount === 0 &&
  gated.sizing_warnings.some((w) => w.includes('stress_survival_below_60'))
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  Sample:  base formula → 1,250 shares, ₹18,75,000 capital, ₹50,000 risk');
console.log('  Liquidity-capped quantity = floor(₹2L / 1500) = 133');
console.log('  Single-stock-capped quantity = floor(₹1L remaining / 1500) = 66');
console.log('  Sector-capped quantity = floor(₹50k remaining / 1500) = 33');
console.log('  Total-risk-capped quantity = floor(₹5k remaining / ₹40 risk-per-unit) = 125');
console.log('  Gate failure → quantity=0, capital=0, risk=0, method=gate_blocked');
console.log('');
console.log(ok
  ? 'RESULT: Phase-9 position sizing engine honours the spec.'
  : 'RESULT: At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
