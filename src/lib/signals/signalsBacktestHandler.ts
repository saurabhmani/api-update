// ════════════════════════════════════════════════════════════════
//  signalsBacktestHandler — shared backtest execution for routes.
//
//  Extracted from GET /api/signals/backtest so daily-report can
//  attach a preview without a nested HTTP round-trip + duplicate
//  /api/signals fetch.
// ════════════════════════════════════════════════════════════════

import {
  runDailyBacktest,
  intervalForBacktestWindow,
  type BacktestResult,
  type BacktestWindow,
  type SignalForBacktest,
  type RunBacktestInput,
} from '@/lib/signals/dailyBacktestEngine';
import { toIstCalendarDate } from '@/lib/marketData/marketHours';
import {
  buildBacktestEodWarehouseLagWarning,
  getHistoricalCandlesBatch,
  getLatestEodTradeDateInWarehouse,
  getMarketMovers,
  type HistoricalCandle,
  type HistoricalInterval,
} from '@/lib/signals/historicalMarketData';
import type { ApiPerfTracker } from '@/lib/api/apiPerf';
import { timedSql } from '@/lib/api/apiPerf';
import type { DailyReportBacktestPreview } from '@/lib/signals/dailySignalReport';

const VALID_WINDOWS = new Set<BacktestWindow>(['INTRADAY', '1D', '7D', '30D', '90D', 'CUSTOM']);

const isoDate = (s?: string | null): string | null => {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const todayISO = (): string => toIstCalendarDate(new Date());

const subtractDaysISO = (iso: string, days: number): string => {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

export const resolveBacktestWindow = (
  window: BacktestWindow,
  customStart: string | null,
  customEnd:   string | null,
): { startDate: string; endDate: string } => {
  const end = customEnd ?? todayISO();
  if (window === 'CUSTOM') {
    return { startDate: customStart ?? end, endDate: end };
  }
  if (window === 'INTRADAY' || window === '1D') return { startDate: end, endDate: end };
  if (window === '7D')  return { startDate: subtractDaysISO(end, 6),  endDate: end };
  if (window === '30D') return { startDate: subtractDaysISO(end, 29), endDate: end };
  if (window === '90D') return { startDate: subtractDaysISO(end, 89), endDate: end };
  return { startDate: end, endDate: end };
};

export function parseBacktestWindow(raw: string | null): BacktestWindow {
  const w = (raw ?? '1D').toUpperCase() as BacktestWindow;
  return VALID_WINDOWS.has(w) ? w : '1D';
}

const arr = <T,>(v: unknown): T[] => Array.isArray(v) ? (v as T[]) : [];

export interface SignalsBacktestResponse {
  ok:          true;
  source:      'computed' | 'partial';
  generatedAt: string;
  backtest:    BacktestResult | null;
  warnings:    string[];
  meta?: {
    symbolsQueried:     number;
    symbolsWithCandles: number;
    outcomesAvailable:  number;
    outcomesTotal:      number;
    candleInterval:     HistoricalInterval;
    startDate:          string;
    endDate:            string;
  };
}

export interface RunSignalsBacktestOptions {
  window:       BacktestWindow;
  customStart?: string | null;
  customEnd?:   string | null;
  signalsPayload: unknown;
  perf?:        ApiPerfTracker;
  /** Reuse movers already fetched by daily-report (skip duplicate SQL). */
  marketMovers?: import('@/lib/signals/historicalMarketData').MarketMover[];
  /** Override symbol cap (preview defaults to 40 for short windows). */
  symbolCap?: number;
  /** Soft deadline — skip movers if budget nearly exhausted (candles already loaded). */
  deadlineMs?: number;
  startedAt?: number;
}

/** Execute backtest from an existing /api/signals payload (no HTTP). */
export async function runSignalsBacktestFromPayload(
  opts: RunSignalsBacktestOptions,
): Promise<SignalsBacktestResponse> {
  const { window, signalsPayload: payload, perf } = opts;
  const customStart = isoDate(opts.customStart ?? null);
  const customEnd   = isoDate(opts.customEnd ?? null);
  let { startDate, endDate } = resolveBacktestWindow(window, customStart, customEnd);
  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();
  const startedAt = opts.startedAt ?? Date.now();
  const deadlineMs = opts.deadlineMs ?? 7_500;

  if (!payload) {
    return {
      ok: true,
      source: 'partial',
      generatedAt,
      backtest: null,
      warnings: [...warnings, 'No signal pool available — backtest skipped.'],
    };
  }

  const latestEod = perf
    ? await timedSql(perf, 'sql.latest_eod_date', () => getLatestEodTradeDateInWarehouse())
    : await getLatestEodTradeDateInWarehouse();

  if (latestEod && endDate > latestEod) {
    warnings.push(buildBacktestEodWarehouseLagWarning(endDate, latestEod));
    if (window === '1D' || window === 'INTRADAY') {
      startDate = latestEod;
    }
    endDate = latestEod;
  }

  const approved      = arr<SignalForBacktest>((payload as any).approvedSignals      ?? (payload as any).signals);
  const highPotential = arr<SignalForBacktest>((payload as any).highPotentialSignals ?? (payload as any).high_potential);
  const watchlistRaw  = arr<SignalForBacktest>((payload as any).watchlistSignals     ?? (payload as any).watchlist);
  const developing    = arr<SignalForBacktest>((payload as any).developing);
  const scanner       = arr<SignalForBacktest>((payload as any).scanner_candidates);
  const rejected      = arr<SignalForBacktest>((payload as any).rejectedSignals     ?? (payload as any).rejected);
  const watchlist     = [...watchlistRaw, ...developing, ...scanner];

  const allSymbols = new Set<string>();
  for (const r of [...approved, ...highPotential, ...watchlist, ...rejected]) {
    const s = String(r.symbol ?? r.tradingsymbol ?? '').trim();
    if (s) allSymbols.add(s);
  }

  const candleSeriesBySymbol = new Map<string, HistoricalCandle[]>();
  let symbolsWithCandles = 0;
  let interval: HistoricalInterval = intervalForBacktestWindow(window);
  let usedEodFallback = false;

  // Preview windows stay small — 40 symbols is enough for dashboard/engine-health.
  const defaultCap = (window === '1D' || window === 'INTRADAY' || window === '7D') ? 40 : 200;
  const maxCap = opts.symbolCap ?? defaultCap;
  const symbolCap = Math.min(allSymbols.size, maxCap);
  const symbolList = Array.from(allSymbols).map((s) => s.toUpperCase()).slice(0, symbolCap);
  if (symbolCap < allSymbols.size) {
    warnings.push(`Symbol pool capped to ${symbolCap} for the historical query — extend cap when scaling.`);
  }

  const rangeStart = `${startDate} 00:00:00`;
  const rangeEnd   = `${endDate} 23:59:59`;

  const loadBatch = async (syms: string[], iv: HistoricalInterval) => {
    const t0 = Date.now();
    const batch = await getHistoricalCandlesBatch(syms, rangeStart, rangeEnd, iv);
    perf?.addSql(`sql.candles.batch.${iv}`, Date.now() - t0, syms.length);
    return batch;
  };

  if (symbolList.length > 0) {
    const applyBatch = (batch: Map<string, import('@/lib/signals/historicalMarketData').HistoricalCandleResult>) => {
      for (const sym of symbolList) {
        const r = batch.get(sym);
        if (r?.available && r.candles.length > 0) {
          candleSeriesBySymbol.set(sym, r.candles);
          symbolsWithCandles++;
        }
      }
    };

    if (perf) {
      await perf.time('candles.batch.primary', async () => {
        applyBatch(await loadBatch(symbolList, interval));
      }, { interval, symbols: symbolList.length });
    } else {
      applyBatch(await loadBatch(symbolList, interval));
    }

    if (interval !== '1day') {
      const missing = symbolList.filter((s) => !candleSeriesBySymbol.has(s));
      if (missing.length > 0) {
        const eodBatch = perf
          ? await perf.time('candles.batch.eod_fallback', () => loadBatch(missing, '1day'), { missing: missing.length })
          : await loadBatch(missing, '1day');
        for (const sym of missing) {
          const r = eodBatch.get(sym);
          if (r?.available && r.candles.length > 0) {
            candleSeriesBySymbol.set(sym, r.candles);
            symbolsWithCandles++;
            usedEodFallback = true;
          }
        }
      }
    }
  }

  if (usedEodFallback) {
    interval = '1day';
    warnings.push(
      'Intraday candles not in warehouse — backtest used EOD daily bars (run candles:daily for intraday).',
    );
  }
  if (symbolsWithCandles === 0) {
    warnings.push('Historical candle data not available for any backtest symbol. See historicalMarketData.ts for adapter wiring.');
  } else if (symbolsWithCandles < symbolList.length) {
    warnings.push(`Historical candle data available for ${symbolsWithCandles}/${symbolList.length} symbols.`);
  }

  let movers = opts.marketMovers;
  const remainingMs = deadlineMs - (Date.now() - startedAt);
  if (movers == null) {
    if (remainingMs < 800) {
      warnings.push('Market movers skipped — response budget nearly exhausted.');
      movers = [];
      perf?.mark('market_movers_skipped_budget', { remainingMs });
    } else {
      const moversResult = perf
        ? await perf.time('market_movers', () => getMarketMovers(endDate))
        : await getMarketMovers(endDate);
      if (!moversResult.available) warnings.push(...moversResult.warnings);
      movers = moversResult.movers;
    }
  } else {
    perf?.mark('market_movers_reused', { count: movers.length });
  }

  const input: RunBacktestInput = {
    window,
    startDate,
    endDate,
    signals: { approved, highPotential, watchlist, rejected },
    candleSeriesBySymbol,
    marketMovers: movers,
    warnings,
  };

  const result: BacktestResult = perf
    ? await perf.time('runDailyBacktest', async () => runDailyBacktest(input))
    : runDailyBacktest(input);

  return {
    ok:          true,
    source:      'computed',
    generatedAt: result.generatedAt,
    backtest:    result,
    warnings:    result.warnings,
    meta: {
      symbolsQueried:     symbolList.length,
      symbolsWithCandles: symbolsWithCandles,
      outcomesAvailable:  result.performance.totalTrades - result.performance.insufficientData,
      outcomesTotal:      result.performance.totalTrades,
      candleInterval:     interval,
      startDate,
      endDate,
    },
  };
}

/** Map full backtest result → daily-report preview envelope (unchanged contract). */
export function backtestToDailyReportPreview(bt: BacktestResult): DailyReportBacktestPreview {
  const dataSufficiency: DailyReportBacktestPreview['dataSufficiency'] =
    bt.status === 'COMPLETE' ? 'COMPLETE'
    : bt.status === 'PARTIAL'  ? 'PARTIAL'
    : 'INSUFFICIENT_DATA';

  return {
    status:                  bt.status,
    window:                  bt.window,
    totalTested:             bt.universe?.symbolsTested ?? 0,
    winRate:                 bt.performance?.winRate ?? null,
    approvedWinRate:         bt.tierPerformance?.approved?.winRate ?? null,
    highPotentialWinRate:    bt.tierPerformance?.highPotential?.winRate ?? null,
    topIndicator:            bt.indicatorPerformance?.[0]?.indicator ?? null,
    weakestIndicator:        bt.indicatorPerformance?.[bt.indicatorPerformance.length - 1]?.indicator ?? null,
    dataSufficiency,
    warnings:                Array.isArray(bt.warnings) ? bt.warnings.slice(0, 5) : [],
  };
}
