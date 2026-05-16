// ════════════════════════════════════════════════════════════════
//  Backtest Runner — Main Orchestrator
//
//  Walks through historical trading dates day by day:
//  1. Generate signals using the REAL signal engine (no shortcuts)
//  2. Manage pending signals → entry triggers
//  3. Update open positions → exits
//  4. Track equity curve
//  5. Compute all metrics
//
//  Zero lookahead bias: each day only sees data up to that date.
// ════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { QuantSignal, StrategyName, MarketRegimeLabel } from '../../signal-engine/types/signalEngine.types';
import type {
  BacktestRunConfig, BacktestRunRecord, SimulatedTrade, SimulatedSignal, EquityPoint,
  OpenPosition, PendingSignal, TradeDirection, BacktestSummary,
  StrategyBreakdownResult, RegimeBreakdownResult, BacktestAuditEntry,
} from '../types';

export interface PerformanceMetrics {
  totalRuntimeMs: number;
  memoryRssMb: number | null;
  memoryHeapMb: number | null;
  signalsPerSec: number;
  tradesPerSec: number;
  symbolsProcessed: number;
  tradingDays: number;
  msPerTradingDay: number;
  // Section 1 extensions — populated when available, older runs keep null.
  preloadMs?: number;
  simulationMs?: number;
  avgMsPerSymbol?: number;
  maxMsPerSymbol?: number;
  concurrency?: number;
}

/**
 * Full backtest result — the in-memory truth chain produced by a single run.
 * Every field that needs to be persisted is exposed here so the orchestrator
 * never has to reconstruct anything.
 */
export interface BacktestRunResult extends BacktestRunRecord {
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  signals: SimulatedSignal[];
  auditEntries: BacktestAuditEntry[];
  performance: PerformanceMetrics;
}
import { validateBacktestConfig } from '../utils/validation';
import { preloadCandleData, buildDataStoreFromMap, DEFAULT_PRELOAD_CONCURRENCY } from '../data/historicalCandleProvider';
import { validateDataStore } from '../data/candleValidator';
import { createLogger } from '../utils/logger';
import { generatePhase1Signals } from '../../signal-engine/pipeline/generatePhase1Signals';
import { getSector } from '../../signal-engine/constants/phase3.constants';
import { buildBacktestTag } from '../../manipulation-engine/backtest/tagSignals';
import { buildNewsTag } from '../replay/newsReplay';
import type { DailyBar } from '../../manipulation-engine/types';
import { AuditLogger } from '../repository/auditLogger';
import {
  checkEntryTrigger, checkExit, updateExcursions,
  calculateBacktestPositionSize, closePosition,
} from '../simulation/tradeSimulator';
import {
  computeBacktestSummary, computeStrategyBreakdown, computeRegimeBreakdown,
} from '../metrics/computeMetrics';
import { setBacktestMode } from '../../marketData/tickStore';

/**
 * Run a full backtest with the given configuration.
 * This is the main entry point for the backtesting engine.
 */
export async function runBacktest(config: BacktestRunConfig): Promise<BacktestRunResult> {
  const runId = config.runId || uuidv4();
  const startedAt = new Date().toISOString();
  const runStartMs = Date.now();
  const memBefore = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : null;

  // Structured logger bound to this run (Section 4).
  const log = createLogger(
    { runId, component: 'backtest', step: 'created' },
    { debug: config.debug === true },
  );
  log.info('run_started', {
    name: config.name,
    universe: config.universe.length,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  // Per-symbol timing accumulator for performance metrics (Section 1).
  const symbolTimings = new Map<string, number>();

  // Audit logger is created FIRST so every phase boundary is captured,
  // including config validation and data loading. lastSuccessfulStep is
  // tracked so failed runs surface where they died.
  const audit = new AuditLogger(runId);
  let lastSuccessfulStep = 'created';

  audit.log(0, 'run_started', `Backtest started: ${config.name}`, null, {
    universe: config.universe.length,
    startDate: config.startDate,
    endDate: config.endDate,
    initialCapital: config.initialCapital,
    fillModel: config.fillModel,
    warmupBars: config.warmupBars,
  });

  // ── Phase 1: Validate config ────────────────────────────
  const validation = validateBacktestConfig(config);
  if (!validation.valid) {
    audit.log(0, 'run_failed', `Config validation failed: ${validation.errors.join(', ')}`, null,
      { errors: validation.errors, lastSuccessfulStep });
    return createFailedRun(runId, config, startedAt, `Config validation failed: ${validation.errors.join(', ')}`, audit.getEntries(), lastSuccessfulStep);
  }
  audit.log(0, 'config_validated', `Config validated successfully`, null, {});
  lastSuccessfulStep = 'config_validated';

  console.log(`[Backtest] Starting run ${runId}: ${config.name}`);
  console.log(`[Backtest] Universe: ${config.universe.length} symbols, ${config.startDate} to ${config.endDate}`);

  // ── DATA SOURCE ISOLATION ──────────────────────────────
  // Flip the global flag so any accidental tickStore call
  // during the backtest throws immediately. Cleared in the
  // finally block below so the live path keeps working.
  setBacktestMode(true);
  console.log(
    `[DATA SOURCE] path=BACKTEST  channel=market_data_daily / candles (DB)  ` +
    `real_time=NO (historical only)  range=${config.startDate}→${config.endDate}`
  );

  try {
    // ── Phase 2: Preload all candle data ────────────────────
    console.log('[Backtest] Preloading candle data...');
    log.setStep('preload_candles');
    const allSymbols = [...config.universe, config.benchmarkSymbol];
    const concurrency = Math.max(1, config.maxConcurrency ?? DEFAULT_PRELOAD_CONCURRENCY);
    const preloadStartMs = Date.now();
    let dataStore = await preloadCandleData(allSymbols, config.startDate, config.endDate, concurrency);
    const preloadMs = Date.now() - preloadStartMs;
    log.info('preload_done', { ms: preloadMs, symbols: dataStore.symbolsLoaded, candles: dataStore.candlesLoaded, concurrency });

    console.log(`[Backtest] Loaded ${dataStore.candlesLoaded} candles for ${dataStore.symbolsLoaded} symbols`);
    console.log(`[Backtest] ${dataStore.tradingDates.length} trading dates in range`);

    audit.log(0, 'data_loaded', `Loaded ${dataStore.candlesLoaded} candles for ${dataStore.symbolsLoaded} symbols`, null, {
      candles: dataStore.candlesLoaded,
      symbols: dataStore.symbolsLoaded,
      tradingDates: dataStore.tradingDates.length,
    });
    lastSuccessfulStep = 'data_loaded';

    // ── Phase 2.5: Validate + repair candle data (Section 1) ──
    const strict = config.strictDataMode === true;
    const { cleaned, report: validationReport } = validateDataStore(dataStore.rawData, strict);

    if (validationReport.totalRepairs > 0) {
      audit.log(0, 'data_repair_applied',
        `Repaired ${validationReport.totalRepairs} candles across ${validationReport.symbolReports.filter(s => s.repaired > 0).length} symbols`,
        null, { totalRepairs: validationReport.totalRepairs, totalDropped: validationReport.totalDropped });
    }
    if (validationReport.rejectedSymbols.length > 0) {
      audit.log(0, 'data_rejected',
        `Rejected ${validationReport.rejectedSymbols.length} symbols due to data issues (strictDataMode=${strict})`,
        null, { rejectedSymbols: validationReport.rejectedSymbols });
    }

    // Rebuild the data store from the cleaned/validated map — preserve per-symbol
    // preload timings so the final perf metrics reflect the full load phase.
    dataStore = buildDataStoreFromMap(cleaned, config.startDate, config.endDate, {
      symbolLoadMs: dataStore.symbolLoadMs,
      preloadMs: dataStore.preloadMs,
    });
    lastSuccessfulStep = 'data_validated';

    if (dataStore.tradingDates.length === 0) {
      audit.log(0, 'run_failed', 'No trading dates found in date range', null, { lastSuccessfulStep });
      return createFailedRun(runId, config, startedAt, 'No trading dates found in date range', audit.getEntries(), lastSuccessfulStep);
    }

    let equity = config.initialCapital;
    let cash = config.initialCapital;
    const openPositions: OpenPosition[] = [];
    const pendingSignals: PendingSignal[] = [];
    const allTrades: SimulatedTrade[] = [];
    const allSignals: SimulatedSignal[] = [];
    const equityCurve: EquityPoint[] = [];
    let totalSignalsGenerated = 0;
    let peakEquity = equity;
    let signalCounter = 0;

    // ── Strict warmup validation (Phase 3 §1) ───────────────
    //
    // The runner refuses to emit signals before `warmupBars` trading
    // days have elapsed. If the configured warmup is ≥ the total
    // trading-date range, no signal can ever fire — the run would
    // quietly produce zero trades. Fail loudly instead so callers
    // see the misconfiguration in the audit log.
    if (config.warmupBars >= dataStore.tradingDates.length) {
      const msg = `Warmup (${config.warmupBars} bars) >= available trading dates (${dataStore.tradingDates.length}). No signal can ever fire.`;
      audit.log(0, 'run_failed', msg, null, {
        warmupBars: config.warmupBars,
        tradingDates: dataStore.tradingDates.length,
        lastSuccessfulStep,
      });
      return createFailedRun(runId, config, startedAt, msg, audit.getEntries(), lastSuccessfulStep);
    }
    const firstEligibleDate = dataStore.tradingDates[config.warmupBars];
    console.log(`[Backtest] Warmup: ${config.warmupBars} bars, first eligible signal date = ${firstEligibleDate}`);
    audit.log(0, 'warmup_validated',
      `Warmup complete at day ${config.warmupBars}; first eligible signal date = ${firstEligibleDate}`,
      null,
      {
        warmupBars: config.warmupBars,
        firstEligibleDate,
        tradingDates: dataStore.tradingDates.length,
      });
    lastSuccessfulStep = 'warmup_validated';

    // ── Step 3: Day-by-day simulation ───────────────────────
    log.setStep('simulation');
    const simulationStartMs = Date.now();
    for (let dayIdx = 0; dayIdx < dataStore.tradingDates.length; dayIdx++) {
      const date = dataStore.tradingDates[dayIdx];
      const provider = dataStore.getProviderForDate(date);

      // Skip warmup period — indicators need sufficient historical bars.
      // Strict invariant: this gate must remain in sync with the
      // `warmup_validated` audit log above. If you ever change one,
      // change the other.
      if (dayIdx < config.warmupBars) continue;

      // 3a. Process exits on open positions
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const candles = await provider.fetchDailyCandles(pos.symbol);
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle || lastCandle.ts.split('T')[0] !== date) continue;

        const barsInTrade = pos.barByBarPnl.length;

        // Update MFE/MAE
        const excursions = updateExcursions(pos, lastCandle);
        pos.currentMfePct = excursions.mfePct;
        pos.currentMaePct = excursions.maePct;

        // Track bar PnL
        const currentPnl = pos.direction === 'long'
          ? (lastCandle.close - pos.entryPrice) * pos.positionSize
          : (pos.entryPrice - lastCandle.close) * pos.positionSize;
        pos.barByBarPnl.push(Math.round(currentPnl * 100) / 100);

        // Check exit — fillModel drives stop/target priority on collision bars
        const exitResult = checkExit(pos, lastCandle, barsInTrade, config.evaluationHorizon, config.fillModel);

        // Update target tracking even without exit
        pos.target1Hit = exitResult.target1Hit;
        pos.target2Hit = exitResult.target2Hit;
        pos.target3Hit = exitResult.target3Hit;

        if (exitResult.exited) {
          // Preserve original signal metadata (Phase 2 spec section 3) — never
          // fall back to generic values; pos already carries the truth.
          const trade = closePosition(pos, exitResult.exitPrice, date, exitResult.exitReason, exitResult, config, {
            signalId: pos.tradeId,
            signalDate: pos.entryDate,
            regime: pos.regime,
            confidenceScore: pos.confidenceScore,
            confidenceBand: pos.confidenceBand,
          });
          allTrades.push(trade);
          cash += pos.positionSize * exitResult.exitPrice - config.commissionPerTrade;
          openPositions.splice(i, 1);

          audit.log(dayIdx, exitResult.exitReason === 'stop_loss' ? 'exit_stop' : exitResult.exitReason?.startsWith('target') ? 'exit_target' : 'exit_expiry',
            `Closed ${pos.symbol}: ${exitResult.exitReason} at ${exitResult.exitPrice.toFixed(2)}, PnL=${trade.netPnl.toFixed(2)}`,
            pos.symbol, { exitReason: exitResult.exitReason, exitPrice: exitResult.exitPrice, netPnl: trade.netPnl, returnR: trade.returnR });
        }
      }

      // 3b. Process entry triggers on pending signals
      for (let i = pendingSignals.length - 1; i >= 0; i--) {
        const sig = pendingSignals[i];

        // Helper: mark the corresponding allSignals entry with a terminal state
        // so backtest_signals.status reflects the truth (Phase 2 spec section 5).
        const markSignal = (status: SimulatedSignal['status']) => {
          const sigRecord = allSignals.find(s => s.signalId === sig.signalId);
          if (sigRecord) sigRecord.status = status;
        };

        // Expire old signals
        sig.barsWaited++;
        if (sig.barsWaited > config.signalExpiryBars) {
          markSignal('expired');
          audit.log(dayIdx, 'signal_expired', `${sig.symbol}: expired after ${sig.barsWaited} bars`,
            sig.symbol, { signalId: sig.signalId, barsWaited: sig.barsWaited });
          pendingSignals.splice(i, 1);
          continue;
        }

        // Check entry trigger
        const candles = await provider.fetchDailyCandles(sig.symbol);
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle || lastCandle.ts.split('T')[0] !== date) continue;

        // ── Invalidation: stop hit before entry was triggered ──
        // (Phase 2 spec section 5 — invalidated_before_entry)
        const stopHitFirst = sig.direction === 'long'
          ? lastCandle.low <= sig.stopLoss
          : lastCandle.high >= sig.stopLoss;
        const entryReachable = sig.direction === 'long'
          ? lastCandle.low <= sig.entryZoneHigh
          : lastCandle.high >= sig.entryZoneLow;

        if (stopHitFirst && !entryReachable) {
          markSignal('filtered');
          audit.log(dayIdx, 'signal_filtered', `${sig.symbol}: invalidated before entry (stop hit, no entry)`,
            sig.symbol, { signalId: sig.signalId, reason: 'invalidated_before_entry' });
          pendingSignals.splice(i, 1);
          continue;
        }

        // Check position limits
        if (openPositions.length >= config.maxOpenPositions) continue;

        // Check sector exposure
        const sectorCount = openPositions.filter(p => getSector(p.symbol) === sig.sector).length;
        if (sectorCount >= 3) continue; // max 3 per sector

        // Duplicate check
        if (openPositions.some(p => p.symbol === sig.symbol)) continue;

        const entry = checkEntryTrigger(sig, lastCandle, config.slippageBps);
        if (!entry.triggered) continue;

        // Size the position
        const currentGross = openPositions.reduce((s, p) => s + p.positionSize * p.entryPrice, 0);
        const sizing = calculateBacktestPositionSize(
          equity, config.riskPerTradePct,
          entry.fillPrice, sig.stopLoss,
          config.maxGrossExposurePct, currentGross,
        );

        if (sizing.positionSize <= 0) continue;
        if (sizing.positionValue > cash) continue; // can't afford

        // Open position
        const tradeId = sig.signalId;
        cash -= sizing.positionValue + config.commissionPerTrade;

        openPositions.push({
          tradeId,
          symbol: sig.symbol,
          direction: sig.direction,
          strategy: sig.strategy,
          regime: sig.regime,
          confidenceScore: sig.confidenceScore,
          confidenceBand: sig.confidenceBand,
          entryPrice: entry.fillPrice,
          stopLoss: sig.stopLoss,
          target1: sig.target1,
          target2: sig.target2,
          target3: sig.target3,
          positionSize: sizing.positionSize,
          riskAmount: sizing.riskAmount,
          entryDate: date,
          entryBarIndex: dayIdx,
          currentMfePct: 0,
          currentMaePct: 0,
          target1Hit: false,
          target2Hit: false,
          target3Hit: false,
          barByBarPnl: [],
        });

        // Mark signal as triggered (Phase 2 spec — preserve full lifecycle truth)
        markSignal('triggered');

        audit.log(dayIdx, 'entry_triggered', `Opened ${sig.symbol}: ${sig.direction} at ${entry.fillPrice.toFixed(2)}, size=${sizing.positionSize}`,
          sig.symbol, { entryPrice: entry.fillPrice, positionSize: sizing.positionSize, strategy: sig.strategy });

        pendingSignals.splice(i, 1);
      }

      // 3c. Generate new signals (run the actual signal engine)
      // Only generate signals periodically (e.g., every day) to match production behavior
      try {
        const p1Config = {
          universe: config.universe,
          benchmarkSymbol: config.benchmarkSymbol,
          timeframe: 'daily' as const,
          minCandleCount: Math.min(config.warmupBars, 220),
          breakoutBuffer: 1.002,
          minAvgVolume: 100_000,
          minPrice: 50,
          minConfidenceToSave: config.minConfidence,
        };

        // Section 4 — timeout protection. Default 30s per signal-gen call.
        const timeoutMs = config.maxSymbolTimeoutMs ?? 30_000;
        let result: Awaited<ReturnType<typeof generatePhase1Signals>>;
        try {
          result = await Promise.race([
            generatePhase1Signals(provider, p1Config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('symbol_timeout')), timeoutMs),
            ),
          ]);
        } catch (err) {
          if ((err as Error).message === 'symbol_timeout') {
            audit.log(dayIdx, 'symbol_timeout',
              `Signal generation exceeded ${timeoutMs}ms on ${date}`,
              null, { timeoutMs });
            continue;
          }
          throw err;
        }
        totalSignalsGenerated += result.signals.length;
        if (result.signals.length > 0) {
          audit.log(dayIdx, 'signal_generated', `Generated ${result.signals.length} signals on ${date}`, null, { count: result.signals.length });
        }

        // Convert signals to pending
        for (const sig of result.signals) {
          // Filter by strategies if configured
          if (config.strategies && !config.strategies.includes(sig.signalType as StrategyName)) continue;

          // Skip if already have pending/open for this symbol
          if (pendingSignals.some(p => p.symbol === sig.symbol)) continue;
          if (openPositions.some(p => p.symbol === sig.symbol)) continue;

          // ── Per-symbol warmup readiness gate (Phase 2 spec section 2) ──
          // The global dayIdx warmup is necessary but not sufficient — each
          // symbol may have started trading later in the dataset and have
          // fewer than warmupBars of usable history. Reject under-warmed symbols.
          const symCandles = await provider.fetchDailyCandles(sig.symbol);
          if (symCandles.length < config.warmupBars) {
            audit.log(dayIdx, 'signal_filtered',
              `${sig.symbol}: under-warmed (${symCandles.length}/${config.warmupBars} bars)`,
              sig.symbol, { reason: 'insufficient_history', barsAvailable: symCandles.length, required: config.warmupBars });
            continue;
          }

          // R:R check
          if (sig.rewardRiskApprox < config.minRewardRisk) continue;

          // Stop width check
          const stopWidth = Math.abs(sig.entry.zoneHigh - sig.stopLoss) / sig.entry.zoneHigh * 100;
          if (stopWidth > config.maxStopWidthPct) continue;

          signalCounter++;
          const signalId = `${runId}-${signalCounter}`;
          const riskPerUnit = Math.abs(sig.entry.zoneHigh - sig.stopLoss);
          const direction = (sig.signalType === 'bearish_breakdown' ? 'short' : 'long') as TradeDirection;
          const strategy = sig.signalType as StrategyName;
          const sector = getSector(sig.symbol);
          const t3 = sig.signalType === 'bearish_breakdown'
            ? sig.entry.zoneHigh - 3.5 * riskPerUnit
            : sig.entry.zoneHigh + 3.5 * riskPerUnit;
          const target3 = Math.round(t3 * 100) / 100;

          // ── Phase 3: tag with manipulation snapshot at signal date ──
          // Only runs when the tagging flag is enabled (default ON). The
          // scan is point-in-time safe — buildBacktestTag trims bars to
          // those ≤ signal date inside.
          let manipulationScore: number | null = null;
          let manipulationBand: string | null = null;
          let excludedByManipulation = false;
          const tagEnabled = config.tagManipulationScore !== false;
          if (tagEnabled) {
            try {
              const dailyBars: DailyBar[] = symCandles.map((c: any) => ({
                date: c.date,
                open: Number(c.open),
                high: Number(c.high),
                low: Number(c.low),
                close: Number(c.close),
                volume: Number(c.volume ?? 0),
              }));
              const tag = buildBacktestTag(sig.symbol, dailyBars, date, config.manipulationFilterScore);
              if (tag) {
                manipulationScore = tag.manipulationScore;
                manipulationBand = tag.manipulationBand;
                excludedByManipulation = tag.excluded;
                if (excludedByManipulation) {
                  audit.log(dayIdx, 'signal_filtered',
                    `${sig.symbol}: excluded by manipulation filter (score=${tag.manipulationScore})`,
                    sig.symbol,
                    { reason: 'manipulation_filter', score: tag.manipulationScore, band: tag.manipulationBand });
                  // Persist the row so the with/without comparison still sees it,
                  // but mark status='filtered' so it never enters trading flow.
                }
              }
            } catch (err) {
              // Don't let a tagging error kill the backtest — fall through silently.
              // The signal still persists with manipulation_score=null.
              void err;
            }
          }

          // ── Phase 5: tag with news intelligence at signal date ──
          // Same pattern as manipulation tagging: query scored events
          // from signal date, apply modifier if configured, filter if
          // event risk exceeds threshold. News must ENHANCE decisions,
          // NOT replace system logic.
          let newsImpactScore: number | null = null;
          let newsConfidenceModifier: number | null = null;
          let newsRiskPenalty: number | null = null;
          let newsEventRiskScore: number | null = null;
          let newsSentiment: 'bullish' | 'bearish' | 'neutral' | null = null;
          let newsWarnings: string[] = [];
          let excludedByNews = false;
          let adjustedConfidence = sig.confidenceScore;

          try {
            const newsTag = await buildNewsTag(sig.symbol, date, config.newsFilterScore);
            if (newsTag) {
              newsImpactScore = newsTag.impactScore;
              newsConfidenceModifier = newsTag.confidenceModifier;
              newsRiskPenalty = newsTag.riskPenalty;
              newsEventRiskScore = newsTag.eventRiskScore;
              newsSentiment = newsTag.sentiment;
              newsWarnings = newsTag.warnings;
              excludedByNews = newsTag.excluded;

              if (excludedByNews) {
                audit.log(dayIdx, 'signal_filtered',
                  `${sig.symbol}: excluded by news filter (eventRisk=${newsTag.eventRiskScore})`,
                  sig.symbol,
                  { reason: 'news_filter', eventRisk: newsTag.eventRiskScore });
              } else if (config.applyNewsModifier && newsTag.confidenceModifier !== 0) {
                adjustedConfidence = Math.max(0, Math.min(100,
                  sig.confidenceScore + newsTag.confidenceModifier));
              }
            }
          } catch {
            // Don't let news tagging error kill the backtest
          }

          const excluded = excludedByManipulation || excludedByNews;

          // Capture full signal for persistence and audit. Tagged signals
          // that the manipulation or news filter excluded are still recorded — with
          // status='filtered' so a "with vs without" comparison can use them.
          allSignals.push({
            signalId,
            symbol: sig.symbol,
            date,
            barIndex: dayIdx,
            direction,
            strategy,
            regime: sig.marketRegime,
            confidenceScore: adjustedConfidence,
            confidenceBand: sig.confidenceBand,
            riskScore: sig.riskScore,
            sector,
            entryZoneLow: sig.entry.zoneLow,
            entryZoneHigh: sig.entry.zoneHigh,
            stopLoss: sig.stopLoss,
            target1: sig.targets.target1,
            target2: sig.targets.target2,
            target3,
            riskPerUnit,
            rewardRiskApprox: sig.rewardRiskApprox,
            reasons: sig.reasons,
            warnings: [...sig.warnings, ...newsWarnings],
            status: excluded ? 'filtered' : 'pending',
            barsWaited: 0,
            expiryDate: null,
            featuresSnapshot: sig.features,
            confidenceBreakdown: sig.confidenceBreakdown,
            manipulationScore,
            manipulationBand,
            excludedByManipulationFilter: excludedByManipulation,
            newsImpactScore,
            newsConfidenceModifier,
            newsRiskPenalty,
            newsEventRiskScore,
            newsSentiment,
            newsWarnings,
            excludedByNewsFilter: excludedByNews,
          });

          // Skip placing this signal in the pending queue if any filter
          // excluded it — the run continues as if it never qualified.
          if (excluded) continue;

          pendingSignals.push({
            signalId,
            symbol: sig.symbol,
            direction,
            strategy,
            regime: sig.marketRegime,
            confidenceScore: adjustedConfidence,
            confidenceBand: sig.confidenceBand,
            sector,
            entryZoneLow: sig.entry.zoneLow,
            entryZoneHigh: sig.entry.zoneHigh,
            stopLoss: sig.stopLoss,
            target1: sig.targets.target1,
            target2: sig.targets.target2,
            target3,
            riskPerUnit,
            signalDate: date,
            signalBarIndex: dayIdx,
            barsWaited: 0,
          });
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        audit.log(dayIdx, 'signal_gen_error',
          `Signal generation failed on ${date}: ${msg}`,
          null, { error: msg });
        if (dayIdx === config.warmupBars || dayIdx % 25 === 0) {
          console.error(`[Backtest] signal-gen error day ${dayIdx} (${date}):`, msg);
        }
      }

      // 3d. Update equity curve
      const openValue = openPositions.reduce((s, p) => {
        // Mark-to-market using last available close
        return s + p.positionSize * p.entryPrice + (p.barByBarPnl.length > 0 ? p.barByBarPnl[p.barByBarPnl.length - 1] : 0);
      }, 0);
      equity = cash + openValue;
      peakEquity = Math.max(peakEquity, equity);
      const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;

      const prevEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : config.initialCapital;

      equityCurve.push({
        date,
        equity: Math.round(equity * 100) / 100,
        cash: Math.round(cash * 100) / 100,
        openPositionValue: Math.round(openValue * 100) / 100,
        drawdownPct: Math.round(drawdownPct * 100) / 100,
        openPositions: openPositions.length,
        dayPnl: Math.round((equity - prevEquity) * 100) / 100,
      });

      // Progress logging every 50 days
      if (dayIdx % 50 === 0) {
        console.log(`[Backtest] Day ${dayIdx}/${dataStore.tradingDates.length}: equity=${Math.round(equity)}, positions=${openPositions.length}, trades=${allTrades.length}`);
      }
    }

    // ── Step 4: Force-close remaining positions at last bar ──
    for (const pos of openPositions) {
      const lastDate = dataStore.tradingDates[dataStore.tradingDates.length - 1];
      const provider = dataStore.getProviderForDate(lastDate);
      const candles = await provider.fetchDailyCandles(pos.symbol);
      const lastCandle = candles[candles.length - 1];
      const exitPrice = lastCandle?.close ?? pos.entryPrice;

      const trade = closePosition(pos, exitPrice, lastDate, 'time_expiry', {
        exited: true, exitPrice, exitReason: 'time_expiry',
        target1Hit: pos.target1Hit, target2Hit: pos.target2Hit,
        target3Hit: pos.target3Hit, stopHit: false,
      }, config, {
        signalId: pos.tradeId, signalDate: pos.entryDate,
        // Preserve original signal metadata (Phase 2 spec section 3)
        regime: pos.regime,
        confidenceScore: pos.confidenceScore,
        confidenceBand: pos.confidenceBand,
      });
      allTrades.push(trade);
    }

    // ── Phase 4: Simulation complete ─────────────────────────
    audit.log(dataStore.tradingDates.length - 1, 'simulation_completed',
      `Simulation complete: ${allTrades.length} trades from ${allSignals.length} signals`,
      null, {
        trades: allTrades.length,
        signals: allSignals.length,
        equityPoints: equityCurve.length,
        forceClosedAtEnd: openPositions.length,
      });
    lastSuccessfulStep = 'simulation_completed';

    // ── Phase 5: Compute all metrics ────────────────────────
    const summary = computeBacktestSummary(allTrades, equityCurve, config, totalSignalsGenerated);
    const strategyBreakdown = computeStrategyBreakdown(allTrades);
    const regimeBreakdown = computeRegimeBreakdown(allTrades);

    audit.log(dataStore.tradingDates.length - 1, 'metrics_computed',
      `Metrics computed: ${(summary.winRate * 100).toFixed(0)}% win rate, ${summary.totalReturnPct.toFixed(2)}% return`,
      null, {
        winRate: summary.winRate,
        profitFactor: summary.profitFactor,
        totalReturnPct: summary.totalReturnPct,
        maxDrawdownPct: summary.maxDrawdownPct,
      });
    lastSuccessfulStep = 'metrics_computed';

    audit.log(dataStore.tradingDates.length - 1, 'run_completed',
      `Backtest complete: ${allSignals.length} signals, ${allTrades.length} trades, ${(summary.winRate * 100).toFixed(0)}% win rate`,
      null, { signals: allSignals.length, trades: allTrades.length, winRate: summary.winRate, totalReturn: summary.totalReturnPct, lastSuccessfulStep });

    // Audit entries are returned in the result so the orchestrator can persist
    // them in the same explicit truth-chain transaction (no fire-and-forget).
    const auditEntries = audit.getEntries();

    console.log(`[Backtest] Complete — ${allSignals.length} signals, ${allTrades.length} trades, ${(summary.winRate * 100).toFixed(0)}% win rate, ${summary.totalReturnPct.toFixed(2)}% return`);

    const completedAt = new Date().toISOString();
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    // Any signals still in 'pending' at run-end are either still in pending
    // queue (force-marked as expired) or got missed because the run ended
    // before resolution. Both are tracked as 'expired' for analytics truth.
    for (const sig of allSignals) {
      if (sig.status === 'pending') {
        sig.status = 'expired';
      }
    }

    // ── Performance metrics (Section 1 + 2) ─────────────────
    const totalRuntimeMs = Date.now() - runStartMs;
    const simulationMs = Date.now() - simulationStartMs;
    const memNow = typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : null;

    // Per-symbol timing stats drawn from the preload phase (truthful source
    // for "how long did each symbol take" in a day-by-day runner).
    let avgMsPerSymbol: number | undefined;
    let maxMsPerSymbol: number | undefined;
    if (dataStore.symbolLoadMs && dataStore.symbolLoadMs.size > 0) {
      const vals = Array.from(dataStore.symbolLoadMs.values());
      const total = vals.reduce((a, b) => a + b, 0);
      avgMsPerSymbol = Math.round((total / vals.length) * 100) / 100;
      maxMsPerSymbol = Math.max(...vals);
    }

    const performance: PerformanceMetrics = {
      totalRuntimeMs,
      memoryRssMb: memNow ? Math.round(memNow.rss / (1024 * 1024)) : null,
      memoryHeapMb: memNow ? Math.round(memNow.heapUsed / (1024 * 1024)) : null,
      signalsPerSec: totalRuntimeMs > 0 ? Math.round((allSignals.length / totalRuntimeMs) * 1000 * 100) / 100 : 0,
      tradesPerSec: totalRuntimeMs > 0 ? Math.round((allTrades.length / totalRuntimeMs) * 1000 * 100) / 100 : 0,
      symbolsProcessed: dataStore.symbolsLoaded,
      tradingDays: dataStore.tradingDates.length,
      msPerTradingDay: dataStore.tradingDates.length > 0 ? Math.round((totalRuntimeMs / dataStore.tradingDates.length) * 100) / 100 : 0,
      preloadMs: dataStore.preloadMs,
      simulationMs,
      avgMsPerSymbol,
      maxMsPerSymbol,
      concurrency: Math.max(1, config.maxConcurrency ?? DEFAULT_PRELOAD_CONCURRENCY),
    };

    log.info('run_completed', {
      totalRuntimeMs, simulationMs, preloadMs: dataStore.preloadMs,
      signals: allSignals.length, trades: allTrades.length,
      signalsPerSec: performance.signalsPerSec,
      tradesPerSec: performance.tradesPerSec,
      memoryHeapMb: performance.memoryHeapMb,
    });

    return {
      runId,
      config,
      status: 'completed',
      startedAt,
      completedAt,
      durationMs,
      error: null,
      summary,
      strategyBreakdown,
      regimeBreakdown,
      signalCount: allSignals.length,
      tradeCount: allTrades.length,
      trades: allTrades,
      equityCurve,
      signals: allSignals,
      auditEntries,
      performance,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Backtest] Run failed:`, err);
    audit.log(0, 'run_failed', `Backtest failed: ${message}`, null, { error: message, lastSuccessfulStep });
    return createFailedRun(runId, config, startedAt, message, audit.getEntries(), lastSuccessfulStep);
  } finally {
    // Always clear the isolation flag so the LIVE path is not
    // left with tickStore locked after a backtest completes.
    setBacktestMode(false);
  }
}

function createFailedRun(
  runId: string,
  config: BacktestRunConfig,
  startedAt: string,
  error: string,
  existingAudit: BacktestAuditEntry[] = [],
  lastSuccessfulStep: string | null = null,
): BacktestRunResult {
  // If no audit entries provided, emit a synthetic failure event so the
  // failure is itself part of the persisted truth chain (spec section 7).
  const failureAudit: BacktestAuditEntry[] = existingAudit.length > 0 ? existingAudit : [{
    runId,
    timestamp: new Date().toISOString(),
    barIndex: 0,
    action: 'run_failed',
    symbol: null,
    message: `Backtest failed: ${error}`,
    payload: {
      error,
      lastSuccessfulStep,
      config: { name: config.name, startDate: config.startDate, endDate: config.endDate },
    },
  }];

  return {
    runId, config, status: 'failed', startedAt, completedAt: new Date().toISOString(),
    durationMs: 0, error,
    summary: emptySummary(config.initialCapital),
    strategyBreakdown: [], regimeBreakdown: [],
    signalCount: 0, tradeCount: 0,
    trades: [], equityCurve: [], signals: [],
    auditEntries: failureAudit,
    performance: {
      totalRuntimeMs: 0,
      memoryRssMb: null,
      memoryHeapMb: null,
      signalsPerSec: 0,
      tradesPerSec: 0,
      symbolsProcessed: 0,
      tradingDays: 0,
      msPerTradingDay: 0,
    },
  };
}

function emptySummary(capital: number): BacktestRunRecord['summary'] {
  return {
    totalSignalsGenerated: 0, totalTradesTaken: 0, totalWins: 0, totalLosses: 0,
    winRate: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0, expectancyPct: 0, expectancyR: 0,
    totalReturnPct: 0, annualizedReturnPct: 0, maxDrawdownPct: 0, maxDrawdownDuration: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    avgMfePct: 0, avgMaePct: 0, avgBarsInTrade: 0,
    target1HitRate: 0, target2HitRate: 0, target3HitRate: 0,
    initialCapital: capital, finalEquity: capital, peakEquity: capital, tradingDays: 0,
  };
}
