/**
 * Verify all MarketDetail tab data sources for a symbol.
 * Usage: npx tsx scripts/verifyMarketDetailTabs.ts MANORAMA
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { fetchQuote, fetchInstrumentMeta } from '../src/services/marketQuote';
import { getChartData } from '../src/services/chartService';
import { revalidateInstrument } from '../src/lib/signal-engine/live/revalidateInstrument';
import { getStockDetail } from '../src/services/stockDetailService';
import { getCompanyNews } from '../src/providers/MarketDataProvider';
import { getNewsForSymbol } from '../src/lib/news-engine/repository/readNewsEvents';
import { getPortfolioContext, computePortfolioFit } from '../src/services/portfolioFitService';
import { db } from '../src/lib/db';

const SYMBOL = (process.argv[2] ?? 'MANORAMA').toUpperCase();
const IKEY = `NSE_EQ|${SYMBOL}`;

type TabResult = {
  tab: string;
  status: 'OK' | 'PARTIAL' | 'EMPTY' | 'ERROR';
  fields: Record<string, unknown>;
  issues: string[];
};

const results: TabResult[] = [];

function tab(name: string, fields: Record<string, unknown>, issues: string[]): TabResult {
  const hasData = Object.values(fields).some((v) => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
    if (typeof v === 'string') return v.length > 0 && v !== '-';
    if (typeof v === 'object') return Object.keys(v as object).length > 0;
    return true;
  });
  const status: TabResult['status'] =
    issues.some((i) => i.startsWith('ERROR')) ? 'ERROR'
    : !hasData ? 'EMPTY'
    : issues.length > 0 ? 'PARTIAL'
    : 'OK';
  return { tab: name, status, fields, issues };
}

async function main() {
  console.log(`\n=== Market Detail Tab Verification: ${SYMBOL} ===\n`);

  // ── Overview ───────────────────────────────────────────────────
  const overviewIssues: string[] = [];
  let quote: Awaited<ReturnType<typeof fetchQuote>> = null;
  let candles1m: unknown[] = [];
  let inst: { name?: string; sector?: string } | null = null;

  try {
    quote = await fetchQuote(SYMBOL);
    if (!quote?.lastPrice) overviewIssues.push('Quote LTP missing');
  } catch (e: any) {
    overviewIssues.push(`ERROR quote: ${e?.message}`);
  }

  try {
    const chart = await getChartData(SYMBOL, '1minute', undefined, undefined, 50);
    candles1m = chart?.candles ?? [];
    if (candles1m.length === 0) overviewIssues.push('No 1m candles');
  } catch (e: any) {
    overviewIssues.push(`ERROR chart: ${e?.message}`);
  }

  try {
    const instProfile = await import('../src/services/marketQuote').then((m) => m.resolveInstrumentProfile(SYMBOL));
    inst = { name: instProfile.name, sector: instProfile.sector ?? undefined };
  } catch {
    try {
      const { rows } = await db.query(
        `SELECT tradingsymbol, name, sector, instrument_key FROM instruments WHERE tradingsymbol = ? LIMIT 1`,
        [SYMBOL],
      );
      inst = rows[0] as any;
    } catch { /* optional */ }
  }

  results.push(tab('Overview', {
    ltp: quote?.lastPrice ?? null,
    pChange: quote?.pChange ?? null,
    open: quote?.open ?? null,
    dayHigh: quote?.dayHigh ?? null,
    dayLow: quote?.dayLow ?? null,
    volume: quote?.totalTradedVolume ?? null,
    week52_high: quote?.fiftyTwoWeekHigh ?? null,
    week52_low: quote?.fiftyTwoWeekLow ?? null,
    candles_1m: candles1m.length,
    instrument_name: inst?.name ?? SYMBOL,
    in_instruments_table: inst != null,
  }, overviewIssues));

  // ── Signals ──────────────────────────────────────────────────
  const signalIssues: string[] = [];
  let signal: Awaited<ReturnType<typeof revalidateInstrument>> | null = null;
  try {
    signal = await revalidateInstrument(IKEY, SYMBOL, 'NSE', { persistInvalidation: false });
    if (!signal) signalIssues.push('No signal response');
    else if (!signal.approved && !signal.signal) signalIssues.push('No active signal (rejected or empty)');
    else if (signal.signal && !signal.signal.entry_price) signalIssues.push('Signal missing entry_price');
  } catch (e: any) {
    signalIssues.push(`ERROR signal: ${e?.message}`);
  }

  results.push(tab('Signals', {
    approved: signal?.approved ?? null,
    revalidation: signal?.revalidation?.status ?? null,
    direction: signal?.signal?.direction ?? null,
    confidence: signal?.confidence_score ?? signal?.signal?.confidence ?? null,
    entry: signal?.entry_price ?? (signal?.signal as any)?.entry_price ?? null,
    stop_loss: signal?.stop_loss ?? (signal?.signal as any)?.stop_loss ?? null,
    target1: signal?.target1 ?? (signal?.signal as any)?.target1 ?? null,
    portfolio_fit: signal?.portfolio_fit_score ?? (signal?.signal as any)?.portfolio_fit ?? null,
  }, signalIssues));

  // ── Technicals (derived from signal + quote) ─────────────────
  const techIssues: string[] = [];
  const entry = (signal?.signal as any)?.entry_price ?? signal?.entry_price;
  const sl = (signal?.signal as any)?.stop_loss ?? signal?.stop_loss;
  const t1 = (signal?.signal as any)?.target1 ?? signal?.target1;
  if (!entry) techIssues.push('Entry zone empty (needs signal levels)');
  if (!quote?.dayHigh) techIssues.push('Day range may be empty');

  results.push(tab('Technicals', {
    direction: signal?.signal?.direction ?? null,
    confidence: signal?.confidence_score ?? null,
    risk: signal?.risk_score ?? null,
    entry_zone: entry ?? null,
    stop_loss: sl ?? null,
    target1: t1 ?? null,
    day_range: quote ? `${quote.dayLow} - ${quote.dayHigh}` : null,
    week52: quote ? `${quote.fiftyTwoWeekLow} - ${quote.fiftyTwoWeekHigh}` : null,
  }, techIssues));

  // ── Financials ───────────────────────────────────────────────
  const finIssues: string[] = [];
  let meta: Awaited<ReturnType<typeof fetchInstrumentMeta>> | null = null;
  try {
    meta = await fetchInstrumentMeta(SYMBOL, quote);
    if (!meta.pe && !meta.eps && !meta.marketCap) finIssues.push('Fundamentals empty (removed vendor may be rate-limited)');
  } catch (e: any) {
    finIssues.push(`ERROR fundamentals: ${e?.message}`);
  }

  results.push(tab('Financials', {
    companyName: meta?.companyName ?? null,
    pe: meta?.pe ?? null,
    eps: meta?.eps ?? null,
    roe: meta?.roe ?? null,
    pbRatio: meta?.pbRatio ?? null,
    dividendYield: meta?.dividendYield ?? null,
    marketCap: meta?.marketCap ?? null,
    sector: meta?.sector ?? inst?.sector ?? null,
  }, finIssues));

  // ── News & Events ────────────────────────────────────────────
  const newsIssues: string[] = [];
  let engineNews: unknown[] = [];
  let companyNews: unknown[] = [];
  try {
    engineNews = await getNewsForSymbol(SYMBOL, 10, 14);
  } catch { /* schema optional */ }
  try {
    const res = await getCompanyNews(SYMBOL);
    companyNews = res.data ?? [];
  } catch (e: any) {
    newsIssues.push(`removed vendor company news: ${e?.message}`);
  }
  if (engineNews.length === 0 && companyNews.length === 0) {
    newsIssues.push('No symbol-specific news from any source');
  }

  results.push(tab('News & Events', {
    engine_db_count: engineNews.length,
    legacy_vendor_count: companyNews.length,
    sample_title: (companyNews[0] as any)?.headline ?? (engineNews[0] as any)?.title ?? null,
  }, newsIssues));

  // ── Portfolio Fit ────────────────────────────────────────────
  const fitIssues: string[] = [];
  let fitScore = signal?.portfolio_fit_score ?? (signal?.signal as any)?.portfolio_fit ?? 0;
  const conf = signal?.confidence_score ?? (signal?.signal as any)?.confidence ?? 0;
  if (!fitScore && conf > 0) fitScore = Math.min(100, conf + 5);

  let portfolioFit: ReturnType<typeof computePortfolioFit> | null = null;
  try {
    const ctx = await getPortfolioContext(1);
    portfolioFit = computePortfolioFit(ctx, meta?.sector ?? inst?.sector ?? 'Other', 'swing', 'BUY');
  } catch (e: any) {
    fitIssues.push(`Portfolio evaluate: ${e?.message}`);
  }

  if (!fitScore && !portfolioFit?.portfolio_fit_score) fitIssues.push('Fit score unavailable');

  results.push(tab('Portfolio Fit', {
    signal_fit_score: fitScore || null,
    evaluated_fit_score: portfolioFit?.portfolio_fit_score ?? null,
    sector: meta?.sector ?? inst?.sector ?? 'Other',
    warnings: portfolioFit?.warnings?.length ?? 0,
    notes: portfolioFit?.notes?.slice(0, 80) ?? null,
  }, fitIssues));

  // ── AI Insight (derived from signal) ─────────────────────────
  const aiIssues: string[] = [];
  if (!signal?.signal) aiIssues.push('No signal for AI narrative');

  results.push(tab('AI Insight', {
    has_signal: !!signal?.signal,
    direction: signal?.signal?.direction ?? null,
    confidence: signal?.confidence_score ?? null,
    conviction: signal?.conviction_band ?? null,
    scenario: signal?.scenario_tag ?? null,
    stance: signal?.market_stance ?? null,
    entry: entry ?? null,
    stop: sl ?? null,
    rr: (signal?.signal as any)?.risk_reward ?? null,
  }, aiIssues));

  // ── History ──────────────────────────────────────────────────
  const histIssues: string[] = [];
  let history: unknown[] = [];
  try {
    const { rows } = await db.query(
      `SELECT direction, confidence_score, entry_price, stop_loss, target1, risk_reward, generated_at
         FROM q365_signals WHERE symbol = ? ORDER BY generated_at DESC LIMIT 10`,
      [SYMBOL],
    );
    history = rows;
    if (history.length === 0) histIssues.push('No q365_signals history rows');
  } catch (e: any) {
    histIssues.push(`ERROR history: ${e?.message}`);
  }

  results.push(tab('History', {
    rows: history.length,
    latest: history[0] ?? null,
  }, histIssues));

  // ── Stock detail fallback ──────────────────────────────────────
  let stockDetail: Awaited<ReturnType<typeof getStockDetail>> = null;
  try {
    stockDetail = await getStockDetail(SYMBOL, '1day', 5);
  } catch { /* optional */ }

  // Print report
  for (const r of results) {
    const icon = r.status === 'OK' ? '✓' : r.status === 'PARTIAL' ? '◐' : r.status === 'EMPTY' ? '○' : '✗';
    console.log(`${icon} ${r.tab.padEnd(18)} [${r.status}]`);
    for (const [k, v] of Object.entries(r.fields)) {
      const val = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 80) : v;
      console.log(`    ${k}: ${val}`);
    }
    for (const issue of r.issues) console.log(`    ⚠ ${issue}`);
    console.log();
  }

  console.log('── Stock detail API (trade levels fallback) ──');
  console.log({
    ltp: stockDetail?.ltp,
    signal_type: stockDetail?.signal_type,
    entry: stockDetail?.entry_price,
    portfolio_fit: stockDetail?.portfolio_fit,
    candles: stockDetail?.candles?.length ?? 0,
  });

  const summary = {
    ok: results.filter((r) => r.status === 'OK').length,
    partial: results.filter((r) => r.status === 'PARTIAL').length,
    empty: results.filter((r) => r.status === 'EMPTY').length,
    error: results.filter((r) => r.status === 'ERROR').length,
  };
  console.log('\n── Summary ──', summary);
  process.exit(summary.error > 0 || summary.empty > 3 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
