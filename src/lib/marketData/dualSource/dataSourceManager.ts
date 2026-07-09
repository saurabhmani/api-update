// Parallel Yahoo + IndianAPI fetch, validate, approve, confirm.

import { logger } from '@/lib/logger';
import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { fetchYahooPublicQuotesBatch } from '@/lib/marketData/yahooChartPublic';
import { getDualSourceConfig } from '@/lib/marketData/providerFlags';
import { evaluateApprovalGateway } from './approvalGateway';
import { runConfirmationEngine } from './confirmationEngine';
import {
  normalizeFromMarketSnapshot,
  normalizeFromYahooQuote,
  normalizedToMarketSnapshot,
} from './feedNormalizer';
import { validateCrossSourceFeeds } from './feedValidator';
import {
  getConfirmationForSymbol,
  recordBatchResult,
  recordSourceFetch,
  setDualSourceMonitoringEnabled,
} from './monitoringService';
import { storeRawTick, storeValidationPipeline } from './storageService';
import type {
  DualSourceBatchResult,
  NormalizedFeedTick,
  SourceFetchResult,
} from './types';

const log = logger.child({ component: 'dataSourceManager' });

const BATCH_SIZE = Math.max(
  1,
  Number(process.env.INDIANAPI_EMULATED_BATCH_MAX) || 50,
);

function resolverRowToTick(sym: string, row: {
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
  source: string;
}, receivedAt: number, latencyMs: number): NormalizedFeedTick | null {
  const price = row.ltp;
  const prevClose = row.close;
  const change = Number.isFinite(prevClose) && prevClose > 0 ? price - prevClose : 0;
  const changePercent = Number.isFinite(prevClose) && prevClose > 0
    ? (change / prevClose) * 100
    : 0;
  const ts = Date.parse(row.timestamp);
  return normalizeFromMarketSnapshot({
    symbol: sym,
    price,
    ltp: price,
    change,
    changePercent,
    volume: row.volume,
    open: row.open,
    high: row.high,
    low: row.low,
    prevClose,
    timestamp: Number.isFinite(ts) ? ts : receivedAt,
  }, 'indianapi', receivedAt, latencyMs);
}

async function fetchYahooSource(symbols: string[]): Promise<Map<string, SourceFetchResult>> {
  const out = new Map<string, SourceFetchResult>();
  const t0 = Date.now();
  try {
    const config = getDualSourceConfig();
    const quotes = await fetchYahooPublicQuotesBatch(symbols, {
      concurrency: config.yahooConcurrency,
      gapMs: Math.max(0, Number(process.env.YAHOO_LIVE_GAP_MS) || 120),
    });
    const latencyMs = Date.now() - t0;
    const seen = new Set<string>();
    for (const q of quotes) {
      const tick = normalizeFromYahooQuote(q, Date.now(), latencyMs);
      if (!tick) continue;
      seen.add(tick.symbol);
      recordSourceFetch('yahoo', true, latencyMs, tick.ltp, null);
      out.set(tick.symbol, { source: 'yahoo', ok: true, tick, error: null, latencyMs });
      void storeRawTick(tick);
    }
    for (const sym of symbols) {
      const up = sym.toUpperCase();
      if (!seen.has(up)) {
        recordSourceFetch('yahoo', false, latencyMs, null, 'no_quote');
        out.set(up, { source: 'yahoo', ok: false, tick: null, error: 'no_quote', latencyMs });
      }
    }
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    for (const sym of symbols) {
      recordSourceFetch('yahoo', false, latencyMs, null, msg);
      out.set(sym.toUpperCase(), { source: 'yahoo', ok: false, tick: null, error: msg, latencyMs });
    }
  }
  return out;
}

async function fetchIndianApiSource(symbols: string[]): Promise<Map<string, SourceFetchResult>> {
  const out = new Map<string, SourceFetchResult>();
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const t0 = Date.now();
    try {
      const result = await resolveBatch(batch, { quiet: true });
      const latencyMs = Date.now() - t0;
      for (const sym of batch) {
        const up = sym.toUpperCase();
        const row = result.data[`NSE:${up}`];
        if (!row || !Number.isFinite(row.ltp) || row.ltp <= 0) {
          recordSourceFetch('indianapi', false, latencyMs, null, 'no_quote');
          out.set(up, { source: 'indianapi', ok: false, tick: null, error: 'no_quote', latencyMs });
          continue;
        }
        const tick = resolverRowToTick(up, row, Date.now(), latencyMs);
        if (!tick) {
          recordSourceFetch('indianapi', false, latencyMs, null, 'normalize_failed');
          out.set(up, { source: 'indianapi', ok: false, tick: null, error: 'normalize_failed', latencyMs });
          continue;
        }
        recordSourceFetch('indianapi', true, latencyMs, tick.ltp, null);
        out.set(up, { source: 'indianapi', ok: true, tick, error: null, latencyMs });
        void storeRawTick(tick);
      }
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      for (const sym of batch) {
        recordSourceFetch('indianapi', false, latencyMs, null, msg);
        out.set(sym.toUpperCase(), { source: 'indianapi', ok: false, tick: null, error: msg, latencyMs });
      }
    }
  }
  return out;
}

function pickPublishTick(
  validation: ReturnType<typeof validateCrossSourceFeeds>,
  approval: ReturnType<typeof evaluateApprovalGateway>,
): NormalizedFeedTick | null {
  if (approval.authoritativeSource && approval.authoritativeLtp != null) {
    const base = approval.authoritativeSource === 'yahoo'
      ? validation.yahoo
      : validation.indianapi;
    if (base) {
      return { ...base, ltp: approval.authoritativeLtp };
    }
  }
  if (validation.yahoo && validation.indianapi) {
    const mid = (validation.yahoo.ltp + validation.indianapi.ltp) / 2;
    return { ...validation.indianapi, ltp: mid };
  }
  return validation.yahoo ?? validation.indianapi ?? null;
}

export function processDualSourceSymbol(
  symbol: string,
  yahoo: NormalizedFeedTick | null,
  indian: NormalizedFeedTick | null,
  now = Date.now(),
): DualSourceBatchResult {
  const config = getDualSourceConfig();
  const validation = validateCrossSourceFeeds(symbol, yahoo, indian, config, now);
  const approval = evaluateApprovalGateway(validation, config, now);
  const confirmation = runConfirmationEngine(validation, approval, {}, now);
  const publishTick = approval.allowed || approval.authoritativeLtp != null
    ? pickPublishTick(validation, approval)
    : null;

  const result: DualSourceBatchResult = {
    symbol: symbol.toUpperCase(),
    validation,
    approval,
    confirmation,
    publishTick,
  };

  recordBatchResult(result);
  void storeValidationPipeline(validation, approval, confirmation);
  return result;
}

/** Fetch both sources in parallel and run the full pipeline per symbol. */
export async function ingestDualSourceBatch(symbols: string[]): Promise<DualSourceBatchResult[]> {
  const config = getDualSourceConfig();
  if (!config.enabled) return [];

  setDualSourceMonitoringEnabled(true);
  const clean = [...new Set(symbols.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean))];
  if (clean.length === 0) return [];

  const [yahooMap, indianMap] = await Promise.all([
    fetchYahooSource(clean),
    fetchIndianApiSource(clean),
  ]);

  const results: DualSourceBatchResult[] = [];
  for (const sym of clean) {
    const yahoo = yahooMap.get(sym)?.tick ?? null;
    const indian = indianMap.get(sym)?.tick ?? null;
    results.push(processDualSourceSymbol(sym, yahoo, indian));
  }

  log.debug('dual-source batch', {
    symbols: clean.length,
    confirmed: results.filter((r) => r.validation.status === 'confirmed').length,
  });

  return results;
}

export { getConfirmationForSymbol };
