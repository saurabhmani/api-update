/**
 * Market Explanation Engine
 *
 * Generates human-readable, context-rich explanations of market conditions
 * and individual instrument signals.
 *
 * Every explanation includes:
 *   - Scenario context (what type of market move this is)
 *   - Confidence framing (how reliable this analysis is)
 *   - Risk posture (what risk stance the current conditions imply)
 *   - Market driver context (what is actually causing the move)
 *
 * Data sources: indices, FII/DII, and option chain delivered through the
 * live quote layer (Kite + Yahoo fallbacks).
 */

import { fetchIndices, fetchFiiDii,
         fetchQuote, fetchIndiaVix }  from './marketQuote';
import { cacheGet, cacheSet }            from '@/lib/redis';

// ── Types ──────────────────────────────────────────────────────────

export interface MarketExplanation {
  headline:        string;
  sentiment:       'Bullish' | 'Bearish' | 'Neutral' | 'Mixed';
  sentimentScore:  number;       // -100 to +100
  scenario:        string;       // e.g. "Sector rotation into Banking"
  regime:          string;       // BULL / BEAR / NEUTRAL etc.
  risk_posture:    string;       // e.g. "Constructive — maintain long bias"
  breadth:         string;
  drivers:         string[];
  cautions:        string[];
  fiiContext:      string;
  optionContext:   string;       // from option chain if available
  sectorLeaders:   string[];
  sectorLaggards:  string[];
  confidence_note: string;       // how reliable is today's analysis
  fullExplanation: string;
  generatedAt:     string;
}

export interface InstrumentExplanation {
  symbol:          string;
  headline:        string;
  scenario:        string;
  priceAction:     string;
  volumeNote:      string;
  contextNote:     string;
  risk_posture:    string;
  sentiment:       'Bullish' | 'Bearish' | 'Neutral';
  keyLevels:       Array<{ label: string; price: number }>;
  confidence_note: string;
  fullNote:        string;
  generatedAt:     string;
}

// ── Sector indices ─────────────────────────────────────────────────

const SECTOR_INDICES = [
  'NIFTY BANK', 'NIFTY IT', 'NIFTY PHARMA', 'NIFTY AUTO',
  'NIFTY FMCG', 'NIFTY REALTY', 'NIFTY METAL', 'NIFTY ENERGY',
  'NIFTY MIDCAP 100',
];

// ── Regime from Redis or derived ──────────────────────────────────

async function getRegime(): Promise<string> {
  try {
    const cached = await cacheGet<{ regime: string }>('market:regime');
    if (cached?.regime) return cached.regime;
  } catch {}
  return 'NEUTRAL';
}

// ── Risk posture from regime ───────────────────────────────────────

function regimeToPosture(regime: string): string {
  const map: Record<string, string> = {
    STRONG_BULL: 'Aggressive — add to leading positions on dips',
    BULL:        'Constructive — maintain long bias, manage stops',
    NEUTRAL:     'Balanced — selective entry only, tight risk control',
    CHOPPY:      'Defensive — reduce size, avoid chasing',
    BEAR:        'Cautious — tighten stops, no new long positions',
    STRONG_BEAR: 'Capital preservation — exit weak positions, hold cash',
  };
  return map[regime] ?? 'Balanced — review positions before adding exposure';
}

// ── Scenario detection from market data ───────────────────────────

function detectScenario(
  niftyChg:   number,
  leaders:    string[],
  laggards:   string[],
  fiiNet:     number,
  vix:        number | null
): string {
  if (Math.abs(niftyChg) < 0.2) return 'Sideways consolidation — low conviction session';

  if (fiiNet > 500 && niftyChg > 0.5) return 'Institutional buying — FII-led rally';
  if (fiiNet < -500 && niftyChg < -0.5) return 'Institutional selling — FII-driven correction';

  if (vix && vix > 20 && niftyChg < -1) return 'Volatility spike — risk-off deleveraging';
  if (vix && vix < 13 && niftyChg > 0.5) return 'Low volatility breakout — complacent rally';

  if (leaders.includes('BANK') && niftyChg > 0.5)
    return 'Banking-led rally — rate-sensitive sector driving gains';
  if (leaders.includes('IT') && niftyChg > 0.3)
    return 'IT sector rotation — global tech sentiment positive';
  if (leaders.length >= 3 && niftyChg > 0.8)
    return 'Broad-based rally — multiple sectors participating';

  if (laggards.length >= 3 && niftyChg < -0.5)
    return 'Broad-based selling — defensive positioning across sectors';

  return niftyChg > 0 ? 'Selective buying — momentum in specific sectors'
                       : 'Selective selling — profit booking in extended stocks';
}

// ── FII/DII context ────────────────────────────────────────────────

async function buildFiiContext(): Promise<{ text: string; net: number }> {
  try {
    const data = await fetchFiiDii();
    if (!data?.length) return { text: 'FII/DII data not yet available for today', net: 0 };

    const latest = data[0];
    // Different upstream response shapes — try multiple field names
    const fiiNet = latest?.fii_net ?? 0;

    const text = Math.abs(fiiNet) < 50
      ? 'FII activity neutral today — no strong directional flow'
      : fiiNet > 0
        ? `FIIs net bought ₹${Math.abs(fiiNet).toFixed(0)} Cr — institutional accumulation`
        : `FIIs net sold ₹${Math.abs(fiiNet).toFixed(0)} Cr — institutional distribution`;

    return { text, net: fiiNet };
  } catch {
    return { text: 'Institutional flow data unavailable', net: 0 };
  }
}

// ── Option context from cached chain ──────────────────────────────

async function buildOptionContext(): Promise<string> {
  try {
    const chain = await cacheGet<any>('options:NIFTY');
    if (!chain?.records?.length) return 'Option chain data available via /api/options?symbol=NIFTY';

    const records = chain.records as any[];
    const totalCeOi = records.reduce((s: number, r: any) => s + (r.ce_oi || 0), 0);
    const totalPeOi = records.reduce((s: number, r: any) => s + (r.pe_oi || 0), 0);
    const pcr = totalCeOi > 0 ? (totalPeOi / totalCeOi).toFixed(2) : null;

    const pcrNum = pcr ? parseFloat(pcr) : null;
    const pcrLabel = !pcrNum ? '' :
      pcrNum > 1.3 ? 'PCR above 1.3 — put-heavy, contrarian bullish' :
      pcrNum < 0.7 ? 'PCR below 0.7 — call-heavy, contrarian bearish' :
      `PCR at ${pcr} — balanced positioning`;

    // Max pain (strike with max combined OI)
    const maxPainStrike = records.reduce((best: any, r: any) =>
      (r.ce_oi + r.pe_oi) > (best.ce_oi + best.pe_oi) ? r : best, records[0]);

    return `${pcrLabel}${maxPainStrike ? `. Max pain near ₹${maxPainStrike.strike_price}` : ''}`;
  } catch {
    return 'Option chain data: fetch via /api/options?symbol=NIFTY';
  }
}

// ══════════════════════════════════════════════════════════════════
//  PUBLIC API: explainMarket
// ══════════════════════════════════════════════════════════════════

export async function explainMarket(): Promise<MarketExplanation> {
  const cacheKey = 'market:explanation';
  const cached   = await cacheGet<MarketExplanation>(cacheKey);
  if (cached) return cached;

  const [indices, regime, fiiCtx, vix, optionCtx] = await Promise.all([
    fetchIndices(),
    getRegime(),
    buildFiiContext(),
    fetchIndiaVix(),
    buildOptionContext(),
  ]);

  const nifty50   = indices.find(i => i.name === 'NIFTY 50');
  const bankNifty = indices.find(i => i.name === 'NIFTY BANK');
  const midcap    = indices.find(i => i.name === 'NIFTY MIDCAP 100');
  const niftyChg  = nifty50?.percentChange ?? 0;

  const sentiment: MarketExplanation['sentiment'] =
    niftyChg > 0.8 ? 'Bullish' : niftyChg < -0.8 ? 'Bearish' :
    niftyChg > 0   ? 'Mixed'   : 'Neutral';

  const sentimentScore = Math.min(100, Math.max(-100, Math.round(niftyChg * 20)));

  const sectorData = indices.filter(i => SECTOR_INDICES.includes(i.name));
  const leaders    = sectorData
    .filter(s => s.percentChange > 0.2)
    .sort((a, b) => b.percentChange - a.percentChange)
    .slice(0, 4);
  const laggards   = sectorData
    .filter(s => s.percentChange < -0.2)
    .sort((a, b) => a.percentChange - b.percentChange)
    .slice(0, 4);

  const leaderNames  = leaders.map(l => l.name.replace('NIFTY ', ''));
  const lagNames     = laggards.map(l => l.name.replace('NIFTY ', ''));
  const advancing    = indices.filter(i => i.percentChange > 0).length;
  const declining    = indices.filter(i => i.percentChange < 0).length;

  const breadth = advancing > declining
    ? `Positive breadth — ${advancing} indices advancing, ${declining} declining`
    : `Weak breadth — ${declining} indices declining, only ${advancing} advancing`;

  const scenario = detectScenario(niftyChg, leaderNames, lagNames, fiiCtx.net, vix);
  const riskPosture = regimeToPosture(regime);

  // Confidence note: depends on data freshness and breadth width
  const dataAge = Math.abs(niftyChg) < 0.01 ? 'Market may be pre-open or closed' : '';
  const confidenceNote = dataAge
    ? `⚠ ${dataAge} — analysis based on last available data`
    : indices.length > 20
      ? 'High confidence — full index dataset available'
      : 'Moderate confidence — partial index data';

  // Drivers and cautions
  const drivers: string[] = [];
  const cautions: string[] = [];

  if (leaderNames.length) drivers.push(`${leaderNames.join(', ')} leading the session`);
  if (fiiCtx.net > 200)   drivers.push(fiiCtx.text);
  if (midcap && midcap.percentChange > niftyChg + 0.3) {
    drivers.push('Midcap outperformance — broad risk appetite confirmed');
  }
  if (vix && vix < 14 && niftyChg > 0) {
    drivers.push(`Low volatility (VIX ${vix.toFixed(1)}) — stable market conditions`);
  }

  if (lagNames.length) cautions.push(`${lagNames.join(', ')} under pressure — selective selling`);
  if (fiiCtx.net < -200) cautions.push(fiiCtx.text);
  if (vix && vix > 18) {
    cautions.push(`Elevated VIX at ${vix.toFixed(1)} — increased uncertainty, widen stops`);
  }

  const headline = niftyChg >= 0
    ? `Nifty up ${niftyChg.toFixed(2)}% — ${scenario.split('—')[0].trim()}`
    : `Nifty down ${Math.abs(niftyChg).toFixed(2)}% — ${scenario.split('—')[0].trim()}`;

  const fullExplanation = [
    `Nifty 50 ${niftyChg >= 0 ? 'gaining' : 'losing'} ${Math.abs(niftyChg).toFixed(2)}% at ${nifty50?.last?.toFixed(0) ?? 'N/A'}.`,
    breadth + '.',
    scenario + '.',
    leaderNames.length ? `Leading sectors: ${leaders.map(l => `${l.name.replace('NIFTY ','')} (${l.percentChange > 0 ? '+' : ''}${l.percentChange.toFixed(1)}%)`).join(', ')}.` : '',
    lagNames.length    ? `Lagging sectors: ${laggards.map(l => `${l.name.replace('NIFTY ','')} (${l.percentChange.toFixed(1)}%)`).join(', ')}.` : '',
    fiiCtx.text + '.',
    bankNifty ? `Bank Nifty ${bankNifty.percentChange >= 0 ? 'up' : 'down'} ${Math.abs(bankNifty.percentChange).toFixed(1)}%.` : '',
    `Risk posture: ${riskPosture}.`,
  ].filter(Boolean).join(' ');

  const result: MarketExplanation = {
    headline, sentiment, sentimentScore,
    scenario, regime, risk_posture: riskPosture,
    breadth,
    drivers:        drivers.slice(0, 4),
    cautions:       cautions.slice(0, 4),
    fiiContext:     fiiCtx.text,
    optionContext:  optionCtx,
    sectorLeaders:  leaders.map(l  => `${l.name.replace('NIFTY ','')} +${l.percentChange.toFixed(1)}%`),
    sectorLaggards: laggards.map(l => `${l.name.replace('NIFTY ','')} ${l.percentChange.toFixed(1)}%`),
    confidence_note: confidenceNote,
    fullExplanation,
    generatedAt: new Date().toISOString(),
  };

  await cacheSet(cacheKey, result, 300);
  return result;
}

// ══════════════════════════════════════════════════════════════════
//  PUBLIC API: explainInstrument
// ══════════════════════════════════════════════════════════════════

export async function explainInstrument(symbol: string): Promise<InstrumentExplanation | null> {
  const cacheKey = `instr:explain:${symbol.toUpperCase()}`;
  const cached   = await cacheGet<InstrumentExplanation>(cacheKey);
  if (cached) return cached;

  const [quote, regime, vix] = await Promise.all([
    fetchQuote(symbol),
    getRegime(),
    fetchIndiaVix(),
  ]);
  if (!quote) return null;

  const pct       = quote.pChange;
  const sentiment: InstrumentExplanation['sentiment'] =
    pct > 0.5 ? 'Bullish' : pct < -0.5 ? 'Bearish' : 'Neutral';

  const riskPosture = regimeToPosture(regime);

  // Scenario for this instrument
  const priceVs52High = quote.fiftyTwoWeekHigh > 0
    ? ((quote.lastPrice - quote.fiftyTwoWeekHigh) / quote.fiftyTwoWeekHigh * 100).toFixed(1)
    : null;

  const scenario =
    priceVs52High && Number(priceVs52High) > -3
      ? `Near 52-week high (${priceVs52High}% away) — breakout zone`
      : pct > 3
        ? 'Strong momentum expansion — buyers aggressive'
        : pct < -3
          ? 'Sharp selling — watch for support levels'
          : quote.vwap && quote.lastPrice > quote.vwap
            ? 'Trading above VWAP — intraday bullish bias'
            : quote.vwap
              ? 'Trading below VWAP — intraday bearish bias'
              : 'Normal session — no extreme patterns';

  const priceAction = `${symbol} ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(2)}% at ₹${quote.lastPrice}`;

  const volumeNote = quote.totalTradedVolume > 5e6
    ? 'Heavy volume confirms conviction in the move'
    : quote.totalTradedVolume > 1e6
      ? 'Above-average volume — meaningful participation'
      : 'Light volume — move may lack broad conviction';

  const contextNote = quote.lastPrice > quote.previousClose
    ? `Above previous close of ₹${quote.previousClose} — buyers in control`
    : `Below previous close of ₹${quote.previousClose} — sellers dominant`;

  const confidenceNote = vix && vix > 20
    ? `High VIX (${vix.toFixed(1)}) — elevated market uncertainty, widen risk parameters`
    : quote.fiftyTwoWeekHigh > 0
      ? `52-week range: ₹${quote.fiftyTwoWeekLow}–₹${quote.fiftyTwoWeekHigh} (live quote data)`
      : 'Intraday data only — historical 52W range not available';

  const keyLevels = [
    { label: "Day High",      price: quote.dayHigh },
    { label: "Day Low",       price: quote.dayLow },
    { label: "Previous Close",price: quote.previousClose },
    { label: "VWAP",          price: quote.vwap ?? 0 },
    { label: "52W High",      price: quote.fiftyTwoWeekHigh },
    { label: "52W Low",       price: quote.fiftyTwoWeekLow },
  ].filter(l => l.price > 0);

  const headline = `${symbol}: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% — ${sentiment.toLowerCase()} session`;

  const fullNote = [
    priceAction + '.',
    volumeNote + '.',
    contextNote + '.',
    scenario + '.',
    `Risk posture: ${riskPosture}.`,
  ].join(' ');

  const result: InstrumentExplanation = {
    symbol, headline, scenario, priceAction, volumeNote,
    contextNote, risk_posture: riskPosture, sentiment, keyLevels,
    confidence_note: confidenceNote, fullNote,
    generatedAt: new Date().toISOString(),
  };

  await cacheSet(cacheKey, result, 120);
  return result;
}
