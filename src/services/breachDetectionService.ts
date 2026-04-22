// ════════════════════════════════════════════════════════════════
//  Breach Detection & Monitoring — Phase 9
//
//  Actively monitor portfolio state, detect breaches, and create
//  decision-relevant alerts. Institutional systems don't only react
//  on demand — they watch.
//
//  Alert categories:
//    risk_breach, concentration_breach, liquidity_deterioration,
//    scenario_threshold, portfolio_drift, governance_warning,
//    signal_alert, stale_data_warning
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { computeExposure, computeConcentration, computeLiquidity, computeDrawdown } from './riskCoreService';
import { getGovernanceRules, getRestrictions } from './governanceService';
import { getHoldings } from './portfolioLedgerService';
import { logBreachDetection } from './auditLogService';

const log = logger.child({ service: 'breachDetection' });

// ── Types ───────────────────────────────────────────────────────

export type BreachCategory =
  | 'risk_breach'
  | 'concentration_breach'
  | 'liquidity_deterioration'
  | 'scenario_threshold'
  | 'portfolio_drift'
  | 'governance_warning'
  | 'signal_alert'
  | 'stale_data_warning';

export type BreachSeverity = 'info' | 'warning' | 'critical';

export interface Breach {
  id?: number;
  portfolioId: number;
  category: BreachCategory;
  severity: BreachSeverity;
  metric: string;
  currentValue: number;
  threshold: number;
  message: string;
  source: string;
  detectedAt: string;
  acknowledged: boolean;
}

export interface MonitoringResult {
  portfolioId: number;
  breaches: Breach[];
  breachCount: number;
  criticalCount: number;
  warningCount: number;
  status: 'clear' | 'warning' | 'breach';
  timestamp: string;
}

// ── Breach Detection Engine ─────────────────────────────────────

async function detectRiskBreaches(portfolioId: number): Promise<Breach[]> {
  const breaches: Breach[] = [];
  const now = new Date().toISOString();

  const [exposure, concentration, liquidity, drawdown] = await Promise.all([
    computeExposure(portfolioId),
    computeConcentration(portfolioId),
    computeLiquidity(portfolioId),
    computeDrawdown(portfolioId),
  ]);

  // Sector exposure breaches
  for (const s of exposure.sectorExposures) {
    if (s.weight > 35) {
      breaches.push({
        portfolioId, category: 'concentration_breach', severity: 'critical',
        metric: `sector_exposure_${s.sector}`, currentValue: s.weight, threshold: 35,
        message: `${s.sector} sector at ${s.weight}% — exceeds 35% hard limit`,
        source: 'exposure_engine', detectedAt: now, acknowledged: false,
      });
    } else if (s.weight > 25) {
      breaches.push({
        portfolioId, category: 'concentration_breach', severity: 'warning',
        metric: `sector_exposure_${s.sector}`, currentValue: s.weight, threshold: 25,
        message: `${s.sector} sector at ${s.weight}% — approaching concentration limit`,
        source: 'exposure_engine', detectedAt: now, acknowledged: false,
      });
    }
  }

  // Single-name concentration
  if (concentration.singleNameConcentration > 25) {
    breaches.push({
      portfolioId, category: 'concentration_breach', severity: 'critical',
      metric: 'single_name_concentration', currentValue: concentration.singleNameConcentration, threshold: 25,
      message: `Single position at ${concentration.singleNameConcentration}% — exceeds 25% limit`,
      source: 'concentration_engine', detectedAt: now, acknowledged: false,
    });
  }

  // Top-5 concentration
  if (concentration.top5Concentration > 70) {
    breaches.push({
      portfolioId, category: 'concentration_breach', severity: 'warning',
      metric: 'top5_concentration', currentValue: concentration.top5Concentration, threshold: 70,
      message: `Top 5 holdings at ${concentration.top5Concentration}% — portfolio is top-heavy`,
      source: 'concentration_engine', detectedAt: now, acknowledged: false,
    });
  }

  // Liquidity deterioration
  const illiquid = liquidity.holdings.filter((h) => h.liquidityStress === 'critical');
  if (illiquid.length > 0) {
    breaches.push({
      portfolioId, category: 'liquidity_deterioration', severity: 'warning',
      metric: 'illiquid_positions', currentValue: illiquid.length, threshold: 0,
      message: `${illiquid.length} positions with critical liquidity stress: ${illiquid.map((h) => h.ticker).join(', ')}`,
      source: 'liquidity_engine', detectedAt: now, acknowledged: false,
    });
  }

  // Drawdown breach
  if (drawdown.currentDrawdown > 15) {
    breaches.push({
      portfolioId, category: 'risk_breach', severity: 'critical',
      metric: 'current_drawdown', currentValue: drawdown.currentDrawdown, threshold: 15,
      message: `Portfolio drawdown at ${drawdown.currentDrawdown}% — exceeds 15% risk limit`,
      source: 'drawdown_engine', detectedAt: now, acknowledged: false,
    });
  } else if (drawdown.currentDrawdown > 8) {
    breaches.push({
      portfolioId, category: 'risk_breach', severity: 'warning',
      metric: 'current_drawdown', currentValue: drawdown.currentDrawdown, threshold: 8,
      message: `Portfolio drawdown at ${drawdown.currentDrawdown}% — monitoring`,
      source: 'drawdown_engine', detectedAt: now, acknowledged: false,
    });
  }

  return breaches;
}

async function detectGovernanceBreaches(portfolioId: number): Promise<Breach[]> {
  const breaches: Breach[] = [];
  const now = new Date().toISOString();
  const holdings = await getHoldings(portfolioId);
  const restrictions = await getRestrictions(portfolioId);

  // Check if any held positions are now in restricted list
  for (const h of holdings) {
    const restricted = restrictions.find(
      (r) => r.ticker === h.ticker && (r.restrictionType === 'banned' || r.restrictionType === 'sell_only'),
    );
    if (restricted) {
      breaches.push({
        portfolioId, category: 'governance_warning', severity: 'critical',
        metric: `restricted_holding_${h.ticker}`, currentValue: 1, threshold: 0,
        message: `Holding ${h.ticker} is now ${restricted.restrictionType}: ${restricted.reason}. Action required.`,
        source: 'governance_engine', detectedAt: now, acknowledged: false,
      });
    }
  }

  return breaches;
}

async function detectStaleData(portfolioId: number): Promise<Breach[]> {
  const breaches: Breach[] = [];
  const now = new Date().toISOString();

  // Check candle freshness
  try {
    const { rows } = await db.query(
      `SELECT MAX(ts) AS latest FROM candles WHERE candle_type = 'eod' AND interval_unit = '1day'`,
    );
    const latest = (rows[0] as any)?.latest;
    if (latest) {
      const ageHours = (Date.now() - new Date(latest).getTime()) / 3600000;
      if (ageHours > 48) {
        breaches.push({
          portfolioId, category: 'stale_data_warning', severity: 'warning',
          metric: 'candle_data_age_hours', currentValue: Math.round(ageHours), threshold: 48,
          message: `Price data is ${Math.round(ageHours)} hours old — risk calculations may be stale`,
          source: 'data_freshness', detectedAt: now, acknowledged: false,
        });
      }
    }
  } catch {}

  return breaches;
}

// ── Monitoring Orchestrator ─────────────────────────────────────

export async function runMonitoringChecks(portfolioId: number): Promise<MonitoringResult> {
  const [riskBreaches, govBreaches, staleBreaches] = await Promise.all([
    detectRiskBreaches(portfolioId),
    detectGovernanceBreaches(portfolioId),
    detectStaleData(portfolioId),
  ]);

  const allBreaches = [...riskBreaches, ...govBreaches, ...staleBreaches];
  const criticalCount = allBreaches.filter((b) => b.severity === 'critical').length;
  const warningCount = allBreaches.filter((b) => b.severity === 'warning').length;

  const status: MonitoringResult['status'] =
    criticalCount > 0 ? 'breach' :
    warningCount > 0 ? 'warning' : 'clear';

  // Persist breaches
  for (const b of allBreaches) {
    try {
      await db.query(
        `INSERT INTO portfolio_breaches
           (portfolio_id, category, severity, metric, current_value, threshold, message, source, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           current_value = VALUES(current_value),
           severity = VALUES(severity),
           message = VALUES(message),
           detected_at = NOW()`,
        [b.portfolioId, b.category, b.severity, b.metric, b.currentValue, b.threshold, b.message, b.source],
      );
    } catch {
      // Table may not exist yet — skip persistence
    }
  }

  // Audit: create compliance record for each detected breach
  // Only audit critical + warning breaches (skip info to avoid noise)
  for (const b of allBreaches.filter(b => b.severity === 'critical' || b.severity === 'warning')) {
    logBreachDetection({
      portfolioId: b.portfolioId,
      metric: b.metric,
      severity: b.severity,
      message: b.message,
    }).catch(err => {
      log.warn('Breach audit persistence failed (non-fatal)', { metric: b.metric, error: (err as Error).message });
    });
  }

  log.info('Monitoring check complete', {
    portfolioId, total: allBreaches.length, critical: criticalCount, warning: warningCount,
  });

  return {
    portfolioId,
    breaches: allBreaches,
    breachCount: allBreaches.length,
    criticalCount,
    warningCount,
    status,
    timestamp: new Date().toISOString(),
  };
}

// ── Get Active Breaches ─────────────────────────────────────────

export async function getActiveBreaches(portfolioId: number): Promise<Breach[]> {
  try {
    const { rows } = await db.query(
      `SELECT * FROM portfolio_breaches
       WHERE portfolio_id = ? AND acknowledged = 0
       ORDER BY FIELD(severity, 'critical', 'warning', 'info'), detected_at DESC
       LIMIT 50`,
      [portfolioId],
    );
    return (rows as any[]).map((r) => ({
      id: r.id,
      portfolioId: r.portfolio_id,
      category: r.category,
      severity: r.severity,
      metric: r.metric,
      currentValue: Number(r.current_value),
      threshold: Number(r.threshold),
      message: r.message,
      source: r.source,
      detectedAt: r.detected_at,
      acknowledged: !!r.acknowledged,
    }));
  } catch {
    // If table doesn't exist, run fresh detection
    const result = await runMonitoringChecks(portfolioId);
    return result.breaches;
  }
}

export async function acknowledgeBreach(breachId: number): Promise<void> {
  await db.query(
    'UPDATE portfolio_breaches SET acknowledged = 1, acknowledged_at = NOW() WHERE id = ?',
    [breachId],
  );
}
