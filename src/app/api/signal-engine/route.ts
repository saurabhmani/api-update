// ════════════════════════════════════════════════════════════════
//  GET /api/signal-engine — Phase 1 Signal Engine API
//
//  Actions:
//    ?action=generate  — run the full pipeline
//    ?action=latest    — fetch latest persisted signals
//    ?action=regime    — fetch current market regime only
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  generatePhase1Signals,
  generatePhase2Signals,
  generatePhase3Signals,
  generatePhase4Signals,
  getLatestSignals,
  detectMarketRegime,
  detectEnhancedRegime,
  DEFAULT_PHASE1_CONFIG,
  DEFAULT_PHASE3_CONFIG,
} from '@/lib/signal-engine';
import type { CandleProvider, PortfolioSnapshot } from '@/lib/signal-engine';
import type { Candle } from '@/lib/signal-engine';
import { db } from '@/lib/db';
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';
import { migrateSignalEngine } from '@/lib/db/migrateSignalEngine';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ── Candle provider: loads from market_data_daily table ──────
const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    // Fetch NEWEST 300 bars, re-sort ASC for the indicator code.
    // Plain `ORDER BY ts ASC LIMIT 300` returns the OLDEST 300.
    const result = await db.query(
      `SELECT ts, open, high, low, close, volume FROM (
         SELECT ts, open, high, low, close, volume
         FROM market_data_daily
         WHERE symbol = ?
         ORDER BY ts DESC
         LIMIT 300
       ) t
       ORDER BY ts ASC`,
      [symbol],
    );
    return result.rows.map((r: any) => ({
      ts: r.ts,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  },
};

// First-call schema guard. `market_data_daily` is a VIEW defined in
// ensureSignalEngineSchemas(), and the candle provider above SELECTs
// from it — without this, the first pipeline run on a fresh DB throws
// "Table 'market_data_daily' doesn't exist", generatePhase3Signals
// fails on the benchmark fetch, and no rows get written.
let _schemaEnsured = false;
async function ensureSchemas() {
  if (_schemaEnsured) return;
  await migrateSignalEngine().catch(() => {});
  await ensureSignalEngineSchemas().catch(() => {});
  _schemaEnsured = true;
}

async function loadPortfolioSnapshot(userId: number): Promise<PortfolioSnapshot> {
  try {
    const { rows: pRows } = await db.query(
      `SELECT id FROM portfolios WHERE user_id=? LIMIT 1`, [userId],
    );
    if (!pRows.length) {
      return { capital: DEFAULT_PHASE3_CONFIG.defaultCapital, cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital, openPositions: [], pendingSignals: [] };
    }
    const portfolioId = (pRows[0] as any).id;
    const { rows: pos } = await db.query(
      `SELECT pp.tradingsymbol AS symbol, pp.quantity, pp.buy_price, pp.current_price,
              COALESCE(i.sector, 'Other') AS sector
       FROM portfolio_positions pp
       LEFT JOIN instruments i ON pp.instrument_id = i.id
       WHERE pp.portfolio_id = ?`,
      [portfolioId],
    );

    const positions = (pos as any[]).map(p => ({
      symbol: p.symbol,
      side: 'long' as const,
      sector: p.sector || 'Other',
      grossValue: (p.quantity || 0) * (p.current_price || p.buy_price || 0),
      riskAllocated: (p.quantity || 0) * (p.buy_price || 0) * 0.005,
    }));

    const totalGross = positions.reduce((s, p) => s + p.grossValue, 0);
    const capital = DEFAULT_PHASE3_CONFIG.defaultCapital;

    return {
      capital,
      cashAvailable: Math.max(0, capital - totalGross),
      openPositions: positions,
      pendingSignals: [],
    };
  } catch {
    return { capital: DEFAULT_PHASE3_CONFIG.defaultCapital, cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital, openPositions: [], pendingSignals: [] };
  }
}

export async function GET(req: NextRequest) {
  let user: any;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const action = req.nextUrl.searchParams.get('action') || 'latest';

  try {
    await ensureSchemas();
    switch (action) {
      case 'generate-v4': {
        const p4Portfolio = await loadPortfolioSnapshot(user.id);
        const result4 = await generatePhase4Signals(
          dbCandleProvider, p4Portfolio,
          undefined, undefined, undefined, undefined,
          { generationSource: 'api:signal-engine:generate-v4' },
        );
        return NextResponse.json({
          data: {
            signals: result4.signals,
            commentary: result4.commentary,
            meta: result4.meta,
          },
        });
      }

      case 'generate-v3': {
        // Load portfolio context from DB
        const portfolio: PortfolioSnapshot = await loadPortfolioSnapshot(user.id);

        const result3 = await generatePhase3Signals(
          dbCandleProvider, portfolio, DEFAULT_PHASE1_CONFIG, DEFAULT_PHASE3_CONFIG,
        );

        return NextResponse.json({
          data: {
            regime: result3.regime,
            signals: result3.signals,
            meta: {
              scanned: result3.scanned,
              approved: result3.approved,
              deferred: result3.deferred,
              rejected: result3.rejected,
              rejections: result3.rejectionLog.length,
            },
          },
        });
      }

      case 'generate-v2': {
        const result = await generatePhase2Signals(
          dbCandleProvider, DEFAULT_PHASE1_CONFIG,
          { generationSource: 'api:signal-engine:generate-v2' },
        );
        return NextResponse.json({
          data: {
            regime: result.regime,
            signals: result.signals.map((s) => {
              // Phase 2 strategy visibility — flatten the conflict
              // resolution onto the signal envelope so callers don't
              // have to reach into a nested object. Empty arrays when
              // the signal didn't beat any competitors.
              const conflict = s.conflictResolution;
              const losingStrategies = conflict?.losingStrategies ?? [];
              const conflictReason = conflict
                ? (conflict.hadDirectionConflict
                    ? `Direction conflict resolved in favor of ${conflict.winningStrategy}`
                    : losingStrategies[0]?.suppressionReason ?? null)
                : null;
              return {
                symbol: s.symbol, timeframe: s.timeframe,
                signalType: s.signalType, signalSubtype: s.signalSubtype,
                action: s.action, marketRegime: s.marketRegime,
                marketContextTag: s.marketContextTag, strengthTag: s.strengthTag,
                strategyName: s.strategyName, strategyConfidence: s.strategyConfidence,
                contextScore: s.contextScore,
                confidenceScore: s.confidenceScore, confidenceBand: s.confidenceBand,
                riskScore: s.riskScore, riskBand: s.riskBand,
                entry: s.entry, stopLoss: s.stopLoss, targets: s.targets,
                rewardRiskApprox: s.rewardRiskApprox,
                reasons: s.reasons, warnings: s.warnings,
                relativeStrength: s.relativeStrength,
                status: s.status, rank: s.rank, generatedAt: s.generatedAt,

                // ── Phase 2 strategy visibility ───────────────
                winning_strategy: conflict?.winningStrategy ?? s.signalType,
                losing_strategies: losingStrategies.map((l) => ({
                  strategy: l.strategy,
                  score: l.score,
                  rejection_reason: l.suppressionReason,
                })),
                conflict_reason: conflictReason,
                strategy_breakdowns: s.strategyBreakdowns ?? [],
              };
            }),
            meta: {
              scanned: result.scanned,
              matched: result.matched,
              rejected: result.rejected.length,
              conflicts: result.conflicts?.length ?? 0,
            },
          },
        });
      }

      case 'regime-v2': {
        const benchmarkCandles = await dbCandleProvider.fetchDailyCandles(DEFAULT_PHASE1_CONFIG.benchmarkSymbol);
        const regime = detectEnhancedRegime(benchmarkCandles);
        return NextResponse.json({ data: { regime } });
      }

      case 'generate': {
        const result = await generatePhase1Signals(
          dbCandleProvider, DEFAULT_PHASE1_CONFIG,
          { generationSource: 'api:signal-engine:generate-v1' },
        );

        // Strip internal breakdown from API response for cleanliness
        const publicSignals = result.signals.map((s) => ({
          symbol: s.symbol,
          timeframe: s.timeframe,
          signalType: s.signalType,
          action: s.action,
          confidenceScore: s.confidenceScore,
          confidenceBand: s.confidenceBand,
          riskScore: s.riskScore,
          riskBand: s.riskBand,
          marketRegime: s.marketRegime,
          entry: s.entry,
          stopLoss: s.stopLoss,
          targets: s.targets,
          rewardRiskApprox: s.rewardRiskApprox,
          reasons: s.reasons,
          warnings: s.warnings,
          status: s.status,
          rank: s.rank,
          generatedAt: s.generatedAt,
        }));

        return NextResponse.json({
          data: {
            regime: result.regime,
            signals: publicSignals,
            meta: {
              scanned: result.scanned,
              matched: result.matched,
              rejected: result.rejected.length,
            },
          },
        });
      }

      case 'latest': {
        const limit = Number(req.nextUrl.searchParams.get('limit')) || 20;
        const signals = await getLatestSignals(limit);
        return NextResponse.json({ data: { signals } });
      }

      case 'regime': {
        const benchmarkCandles = await dbCandleProvider.fetchDailyCandles(
          DEFAULT_PHASE1_CONFIG.benchmarkSymbol,
        );
        const regime = detectMarketRegime(benchmarkCandles);
        return NextResponse.json({ data: { regime } });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[SignalEngine API]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
