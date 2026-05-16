// ════════════════════════════════════════════════════════════════
//  Risk Core — Phase 3
//
//  Institutional risk layer: exposure, concentration, liquidity,
//  drawdown engines with normalized output pattern.
//
//  Every risk metric returns:
//    { metric, value, threshold, severity, explanation }
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getHoldings, computePnl, HoldingRow } from './portfolioLedgerService';
import { getPortfolioContext, type PortfolioContext } from './portfolioFitService';

const log = logger.child({ service: 'riskCore' });

// ── Normalized Risk Metric ──────────────────────────────────────

export type RiskSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface RiskMetric {
  metric: string;
  value: number;
  threshold: number;
  severity: RiskSeverity;
  explanation: string;
}

export interface RiskSummary {
  overallSeverity: RiskSeverity;
  riskScore: number;           // 0–100, higher = riskier
  metrics: RiskMetric[];
  timestamp: string;
}

function severity(value: number, warn: number, crit: number): RiskSeverity {
  if (value >= crit) return 'critical';
  if (value >= warn) return 'warning';
  if (value >= warn * 0.7) return 'info';
  return 'ok';
}

// ── Exposure Engine ─────────────────────────────────────────────

export interface ExposureResult {
  grossExposure: number;
  sectorExposures: { sector: string; value: number; weight: number; severity: RiskSeverity }[];
  instrumentExposures: { ticker: string; value: number; weight: number; severity: RiskSeverity }[];
  metrics: RiskMetric[];
}

export async function computeExposure(portfolioId: number): Promise<ExposureResult> {
  const holdings = await getHoldings(portfolioId);
  const gross = holdings.reduce((s, h) => s + h.marketValue, 0);

  // Sector exposure
  const sectorMap: Record<string, number> = {};
  for (const h of holdings) {
    const s = h.sector ?? 'Other';
    sectorMap[s] = (sectorMap[s] ?? 0) + h.marketValue;
  }
  const sectorExposures = Object.entries(sectorMap)
    .map(([sector, value]) => ({
      sector,
      value,
      weight: gross > 0 ? parseFloat(((value / gross) * 100).toFixed(2)) : 0,
      severity: severity(gross > 0 ? (value / gross) * 100 : 0, 25, 40) as RiskSeverity,
    }))
    .sort((a, b) => b.weight - a.weight);

  // Instrument exposure
  const instrumentExposures = holdings
    .map((h) => ({
      ticker: h.ticker,
      value: h.marketValue,
      weight: h.weight,
      severity: severity(h.weight, 15, 25) as RiskSeverity,
    }))
    .sort((a, b) => b.weight - a.weight);

  const maxSectorWeight = sectorExposures[0]?.weight ?? 0;
  const maxInstrumentWeight = instrumentExposures[0]?.weight ?? 0;

  const metrics: RiskMetric[] = [
    {
      metric: 'gross_exposure',
      value: gross,
      threshold: 0,
      severity: 'info',
      explanation: `Total market value of all positions: ₹${(gross / 100000).toFixed(1)}L`,
    },
    {
      metric: 'max_sector_exposure',
      value: maxSectorWeight,
      threshold: 30,
      severity: severity(maxSectorWeight, 25, 40),
      explanation: maxSectorWeight > 30
        ? `Largest sector (${sectorExposures[0]?.sector}) at ${maxSectorWeight}% exceeds 30% cap`
        : `Largest sector exposure at ${maxSectorWeight}% — within limits`,
    },
    {
      metric: 'max_instrument_exposure',
      value: maxInstrumentWeight,
      threshold: 20,
      severity: severity(maxInstrumentWeight, 15, 25),
      explanation: maxInstrumentWeight > 20
        ? `${instrumentExposures[0]?.ticker} at ${maxInstrumentWeight}% — high single-name exposure`
        : `Largest holding at ${maxInstrumentWeight}% — within limits`,
    },
  ];

  return { grossExposure: gross, sectorExposures, instrumentExposures, metrics };
}

// ── Concentration Engine ────────────────────────────────────────

export interface ConcentrationResult {
  singleNameConcentration: number;
  top5Concentration: number;
  top10Concentration: number;
  sectorConcentration: number;
  metrics: RiskMetric[];
}

export async function computeConcentration(portfolioId: number): Promise<ConcentrationResult> {
  const holdings = await getHoldings(portfolioId);
  const gross = holdings.reduce((s, h) => s + h.marketValue, 0);
  if (gross === 0 || holdings.length === 0) {
    return {
      singleNameConcentration: 0,
      top5Concentration: 0,
      top10Concentration: 0,
      sectorConcentration: 0,
      metrics: [],
    };
  }

  const sorted = [...holdings].sort((a, b) => b.marketValue - a.marketValue);
  const singleName = sorted[0].weight;
  const top5 = sorted.slice(0, 5).reduce((s, h) => s + h.weight, 0);
  const top10 = sorted.slice(0, 10).reduce((s, h) => s + h.weight, 0);

  // Sector HHI (Herfindahl index)
  const sectorMap: Record<string, number> = {};
  for (const h of holdings) {
    const s = h.sector ?? 'Other';
    sectorMap[s] = (sectorMap[s] ?? 0) + h.weight;
  }
  const sectorHHI = Object.values(sectorMap).reduce((s, w) => s + (w / 100) ** 2, 0);
  const sectorConcentration = parseFloat((sectorHHI * 100).toFixed(2));

  const metrics: RiskMetric[] = [
    {
      metric: 'single_name_concentration',
      value: singleName,
      threshold: 20,
      severity: severity(singleName, 15, 25),
      explanation: `Largest position (${sorted[0].ticker}) is ${singleName}% of portfolio`,
    },
    {
      metric: 'top5_concentration',
      value: parseFloat(top5.toFixed(2)),
      threshold: 60,
      severity: severity(top5, 50, 70),
      explanation: `Top 5 holdings represent ${top5.toFixed(1)}% of portfolio value`,
    },
    {
      metric: 'top10_concentration',
      value: parseFloat(top10.toFixed(2)),
      threshold: 80,
      severity: severity(top10, 70, 90),
      explanation: `Top 10 holdings represent ${top10.toFixed(1)}% of portfolio value`,
    },
    {
      metric: 'sector_hhi',
      value: sectorConcentration,
      threshold: 25,
      severity: severity(sectorConcentration, 20, 35),
      explanation: sectorConcentration > 25
        ? `High sector concentration (HHI=${sectorConcentration}) — diversification needed`
        : `Sector diversification adequate (HHI=${sectorConcentration})`,
    },
  ];

  return {
    singleNameConcentration: singleName,
    top5Concentration: parseFloat(top5.toFixed(2)),
    top10Concentration: parseFloat(top10.toFixed(2)),
    sectorConcentration,
    metrics,
  };
}

// ── Liquidity Engine ────────────────────────────────────────────

export interface LiquidityResult {
  holdings: { ticker: string; daysToExit: number; liquidityStress: RiskSeverity }[];
  metrics: RiskMetric[];
}

export async function computeLiquidity(portfolioId: number): Promise<LiquidityResult> {
  const holdings = await getHoldings(portfolioId);
  if (!holdings.length) return { holdings: [], metrics: [] };

  // Fetch average daily volume for each holding
  const tickers = holdings.map((h) => h.ticker);
  const placeholders = tickers.map(() => '?').join(',');

  const { rows: volumeRows } = await db.query(
    `SELECT instrument_key, AVG(volume) AS avg_volume
     FROM candles
     WHERE instrument_key IN (
       SELECT instrument_key FROM instruments WHERE tradingsymbol IN (${placeholders})
     )
     AND candle_type = 'eod' AND interval_unit = '1day'
     AND ts >= DATE_SUB(NOW(), INTERVAL 30 DAY)
     GROUP BY instrument_key`,
    tickers,
  );

  // Map ticker → avg volume
  const volMap: Record<string, number> = {};
  const { rows: instRows } = await db.query(
    `SELECT tradingsymbol, instrument_key FROM instruments WHERE tradingsymbol IN (${placeholders})`,
    tickers,
  );
  const keyMap: Record<string, string> = {};
  for (const r of instRows as any[]) keyMap[r.instrument_key] = r.tradingsymbol;
  for (const r of volumeRows as any[]) {
    const sym = keyMap[r.instrument_key];
    if (sym) volMap[sym] = Number(r.avg_volume ?? 0);
  }

  const liquidityHoldings = holdings.map((h) => {
    const avgVol = volMap[h.ticker] ?? 0;
    // Days to exit = quantity / (20% of avg daily volume)
    const participationRate = 0.20;
    const daysToExit = avgVol > 0
      ? parseFloat((h.quantity / (avgVol * participationRate)).toFixed(1))
      : 999;
    const liquidityStress: RiskSeverity =
      daysToExit > 10 ? 'critical' :
      daysToExit > 5 ? 'warning' :
      daysToExit > 2 ? 'info' : 'ok';

    return { ticker: h.ticker, daysToExit, liquidityStress };
  });

  const illiquidCount = liquidityHoldings.filter((h) => h.liquidityStress === 'warning' || h.liquidityStress === 'critical').length;
  const worstDTE = Math.max(...liquidityHoldings.map((h) => h.daysToExit));

  const metrics: RiskMetric[] = [
    {
      metric: 'illiquid_positions',
      value: illiquidCount,
      threshold: 3,
      severity: severity(illiquidCount, 2, 5),
      explanation: illiquidCount > 0
        ? `${illiquidCount} positions may take >5 days to exit at 20% participation`
        : 'All positions can be exited within 5 trading days',
    },
    {
      metric: 'worst_days_to_exit',
      value: Math.min(worstDTE, 999),
      threshold: 10,
      severity: severity(worstDTE, 5, 15),
      explanation: worstDTE > 10
        ? `Slowest position requires ~${worstDTE.toFixed(0)} days to exit — liquidity risk`
        : `All positions exit within ${worstDTE.toFixed(0)} trading days`,
    },
  ];

  return { holdings: liquidityHoldings, metrics };
}

// ── Drawdown Engine ─────────────────────────────────────────────

export interface DrawdownResult {
  currentDrawdown: number;
  maxDrawdown30d: number;
  worstContributors: { ticker: string; pnlPct: number }[];
  metrics: RiskMetric[];
}

export async function computeDrawdown(portfolioId: number): Promise<DrawdownResult> {
  const holdings = await getHoldings(portfolioId);
  const pnl = await computePnl(portfolioId);

  const currentDrawdown = pnl.totalInvested > 0 && pnl.unrealizedPnl < 0
    ? parseFloat((Math.abs(pnl.unrealizedPnlPct)).toFixed(2))
    : 0;

  // Historical peak-to-trough from snapshots
  const { rows: snapRows } = await db.query(
    `SELECT total_value FROM portfolio_snapshots
     WHERE portfolio_id = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
     ORDER BY snapshot_date`,
    [portfolioId],
  );

  let maxDD30d = 0;
  let peak = 0;
  for (const r of snapRows as any[]) {
    const val = Number(r.total_value);
    if (val > peak) peak = val;
    if (peak > 0) {
      const dd = ((peak - val) / peak) * 100;
      if (dd > maxDD30d) maxDD30d = dd;
    }
  }
  maxDD30d = parseFloat(maxDD30d.toFixed(2));

  // Worst contributors (losers by unrealized P&L %)
  const worstContributors = holdings
    .filter((h) => h.unrealizedPnl < 0)
    .sort((a, b) => a.unrealizedPnlPct - b.unrealizedPnlPct)
    .slice(0, 5)
    .map((h) => ({ ticker: h.ticker, pnlPct: h.unrealizedPnlPct }));

  const metrics: RiskMetric[] = [
    {
      metric: 'current_drawdown',
      value: currentDrawdown,
      threshold: 10,
      severity: severity(currentDrawdown, 8, 15),
      explanation: currentDrawdown > 0
        ? `Portfolio is ${currentDrawdown}% below invested cost basis`
        : 'Portfolio is above cost basis — no drawdown',
    },
    {
      metric: 'max_drawdown_30d',
      value: maxDD30d,
      threshold: 15,
      severity: severity(maxDD30d, 10, 20),
      explanation: maxDD30d > 0
        ? `Worst 30-day peak-to-trough decline was ${maxDD30d}%`
        : 'No drawdown data — snapshots not yet collected',
    },
    {
      metric: 'losing_positions',
      value: worstContributors.length,
      threshold: 5,
      severity: severity(worstContributors.length, 3, 7),
      explanation: worstContributors.length > 0
        ? `${worstContributors.length} positions in loss; worst: ${worstContributors[0]?.ticker} at ${worstContributors[0]?.pnlPct}%`
        : 'No losing positions',
    },
  ];

  return { currentDrawdown, maxDrawdown30d: maxDD30d, worstContributors, metrics };
}

// ── Risk Summary Service ────────────────────────────────────────

export async function computeRiskSummary(portfolioId: number): Promise<RiskSummary> {
  const [exposure, concentration, liquidity, drawdown] = await Promise.all([
    computeExposure(portfolioId),
    computeConcentration(portfolioId),
    computeLiquidity(portfolioId),
    computeDrawdown(portfolioId),
  ]);

  const allMetrics = [
    ...exposure.metrics,
    ...concentration.metrics,
    ...liquidity.metrics,
    ...drawdown.metrics,
  ];

  // Overall severity = worst individual severity
  const severityOrder: RiskSeverity[] = ['ok', 'info', 'warning', 'critical'];
  let overallSeverity: RiskSeverity = 'ok';
  for (const m of allMetrics) {
    if (severityOrder.indexOf(m.severity) > severityOrder.indexOf(overallSeverity)) {
      overallSeverity = m.severity;
    }
  }

  // Risk score: count weighted severity hits
  let riskScore = 0;
  for (const m of allMetrics) {
    if (m.severity === 'info') riskScore += 5;
    if (m.severity === 'warning') riskScore += 15;
    if (m.severity === 'critical') riskScore += 30;
  }
  riskScore = Math.min(100, riskScore);

  return {
    overallSeverity,
    riskScore,
    metrics: allMetrics,
    timestamp: new Date().toISOString(),
  };
}
