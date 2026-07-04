/**
 * Option Intelligence Engine
 * 
 * Converts raw option chain data into actionable interpretation:
 * - Support/Resistance zones from OI
 * - Long/Short build-up detection
 * - Trap zone detection
 * - Expected move calculation
 * - Smart money concentration
 */

import { fetchOptionChain, type OptionChainRow } from './marketQuote';
import { cacheGet, cacheSet } from '@/lib/redis';

export interface OiZone {
  strike:        number;
  type:          'resistance' | 'support';
  strength:      'Strong' | 'Moderate' | 'Weak';
  oi:            number;
  oiChange:      number;
  interpretation: string;
}

export interface BuildupSignal {
  strike:     number;
  optionType: 'CE' | 'PE';
  buildupType:'long_buildup' | 'short_buildup' | 'short_covering' | 'long_unwinding';
  label:      string;
  description: string;
  oi:         number;
  oiChange:   number;
  priceChange: number;
}

export interface OptionChainViewRow {
  strikePrice: number;
  expiryDate: string;
  ceOi: number;
  ceOiChange: number;
  ceIv: number;
  ceLtp: number;
  ceVolume: number;
  ceBid: number;
  ceAsk: number;
  peOi: number;
  peOiChange: number;
  peIv: number;
  peLtp: number;
  peVolume: number;
  peBid: number;
  peAsk: number;
}

export interface OptionMetrics {
  totalCeOi: number;
  totalPeOi: number;
  totalCeVolume: number;
  totalPeVolume: number;
  atmStrike: number;
  atmIv: number;
  avgIv: number;
  ivSkew: number;
  highestCeOiStrike: number | null;
  highestPeOiStrike: number | null;
  chainRows: number;
}

export interface OptionSignal {
  id: string;
  label: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  severity: 'high' | 'medium' | 'low';
  optionType: 'CE' | 'PE' | 'CHAIN';
  strike: number | null;
  description: string;
}

export interface TrapZone {
  lower:       number;
  upper:       number;
  description: string;
  severity:    'High' | 'Medium';
}

export interface OptionIntelligence {
  symbol:           string;
  requestedSymbol?: string;
  underlyingValue:  number;
  expiryDate:       string;
  strongResistance: OiZone[];
  strongSupport:    OiZone[];
  buildups:         BuildupSignal[];
  trapZones:        TrapZone[];
  expectedMoveUp:   number;
  expectedMoveDown: number;
  pcr:              number;
  pcrLabel:         string;
  maxPain:          number;
  ivContext:        string;
  summary:          string;
  generatedAt:      string;
  dataSource:       'live' | 'synthetic' | 'unknown';
  expiryDates:      string[];
  chain:            OptionChainViewRow[];
  metrics:          OptionMetrics;
  optionSignals:    OptionSignal[];
}

function classifyBuildup(oiChange: number, priceChange: number, optionType: 'CE' | 'PE'): BuildupSignal['buildupType'] {
  const oiUp  = oiChange > 0;
  const prUp  = priceChange > 0;
  if (oiUp  && prUp)  return optionType === 'CE' ? 'long_buildup'   : 'short_buildup';
  if (oiUp  && !prUp) return optionType === 'CE' ? 'short_buildup'  : 'long_buildup';
  if (!oiUp && prUp)  return optionType === 'CE' ? 'short_covering' : 'long_unwinding';
  return optionType === 'CE' ? 'long_unwinding' : 'short_covering';
}

const BUILD_LABELS: Record<string, string> = {
  long_buildup:   'Long Build-Up',
  short_buildup:  'Short Build-Up',
  short_covering: 'Short Covering',
  long_unwinding: 'Long Unwinding',
};

const BUILD_DESC: Record<string, string> = {
  long_buildup:   'Fresh longs being added — bullish momentum',
  short_buildup:  'Fresh shorts being added — bearish pressure',
  short_covering: 'Shorts unwinding — potential upside spike',
  long_unwinding: 'Longs exiting — potential downside pressure',
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

function avg(nums: number[]): number {
  const xs = nums.filter((n) => Number.isFinite(n) && n > 0);
  return xs.length ? sum(xs) / xs.length : 0;
}

function normalizeDataSource(source: string | undefined): OptionIntelligence['dataSource'] {
  if (source === 'synthetic') return 'synthetic';
  if (source === 'kite' || source === 'yahoo' || source === 'live') return 'live';
  return 'unknown';
}

function buildOptionSignals(args: {
  pcr: number;
  pcrLabel: string;
  maxPain: number;
  spot: number;
  resistance: OiZone[];
  support: OiZone[];
  buildups: BuildupSignal[];
  ivContext: string;
}): OptionSignal[] {
  const signals: OptionSignal[] = [];

  if (args.pcr >= 1.3) {
    signals.push({
      id: 'pcr-bullish',
      label: 'Put-side OI dominance',
      direction: 'bullish',
      severity: args.pcr >= 1.6 ? 'high' : 'medium',
      optionType: 'CHAIN',
      strike: null,
      description: `${args.pcrLabel}. Put OI exceeds call OI, suggesting support from put writers.`,
    });
  } else if (args.pcr <= 0.7) {
    signals.push({
      id: 'pcr-bearish',
      label: 'Call-side OI dominance',
      direction: 'bearish',
      severity: args.pcr <= 0.5 ? 'high' : 'medium',
      optionType: 'CHAIN',
      strike: null,
      description: `${args.pcrLabel}. Call OI exceeds put OI, suggesting overhead resistance.`,
    });
  }

  const topRes = args.resistance[0];
  if (topRes) {
    signals.push({
      id: `call-wall-${topRes.strike}`,
      label: 'Call wall resistance',
      direction: 'bearish',
      severity: topRes.strength === 'Strong' ? 'high' : 'medium',
      optionType: 'CE',
      strike: topRes.strike,
      description: `Highest call OI sits at ${topRes.strike}; upside may need a decisive breakout above this level.`,
    });
  }

  const topSup = args.support[0];
  if (topSup) {
    signals.push({
      id: `put-wall-${topSup.strike}`,
      label: 'Put wall support',
      direction: 'bullish',
      severity: topSup.strength === 'Strong' ? 'high' : 'medium',
      optionType: 'PE',
      strike: topSup.strike,
      description: `Highest put OI sits at ${topSup.strike}; downside may find support near this level.`,
    });
  }

  const painDistancePct = args.spot > 0 ? ((args.maxPain - args.spot) / args.spot) * 100 : 0;
  if (Math.abs(painDistancePct) >= 0.4) {
    signals.push({
      id: 'max-pain-magnet',
      label: 'Max pain magnet',
      direction: painDistancePct > 0 ? 'bullish' : 'bearish',
      severity: Math.abs(painDistancePct) >= 1 ? 'medium' : 'low',
      optionType: 'CHAIN',
      strike: args.maxPain,
      description: `Max pain is ${round2(Math.abs(painDistancePct))}% ${painDistancePct > 0 ? 'above' : 'below'} spot.`,
    });
  }

  for (const b of args.buildups.slice(0, 4)) {
    const bullish =
      (b.optionType === 'CE' && (b.buildupType === 'long_buildup' || b.buildupType === 'short_covering')) ||
      (b.optionType === 'PE' && (b.buildupType === 'short_buildup' || b.buildupType === 'long_unwinding'));
    signals.push({
      id: `${b.optionType}-${b.buildupType}-${b.strike}`,
      label: `${b.optionType} ${b.label}`,
      direction: bullish ? 'bullish' : 'bearish',
      severity: Math.abs(b.oiChange) > 250_000 ? 'high' : 'medium',
      optionType: b.optionType,
      strike: b.strike,
      description: b.description,
    });
  }

  signals.push({
    id: 'iv-context',
    label: 'IV context',
    direction: 'neutral',
    severity: args.ivContext.startsWith('High') ? 'medium' : 'low',
    optionType: 'CHAIN',
    strike: null,
    description: args.ivContext,
  });

  return signals.slice(0, 8);
}

export async function analyzeOptionChain(symbol: string, expiryIndex = 0): Promise<OptionIntelligence | null> {
  const sym = symbol.trim().toUpperCase();
  const safeExpiryIndex = Math.max(0, Math.floor(Number(expiryIndex) || 0));
  const cacheKey = `optintel:${sym}:expiry:${safeExpiryIndex}`;
  const cached   = await cacheGet<OptionIntelligence>(cacheKey);
  if (cached) return cached;

  const chain = await fetchOptionChain(sym);
  if (!chain || !chain.records.length) return null;
  const resolvedSymbol = chain.symbol ?? sym;

  const expiry  = chain.expiryDates[safeExpiryIndex] ?? chain.expiryDates[0];
  const records = chain.records
    .filter(r => r.expiryDate === expiry)
    .sort((a, b) => a.strikePrice - b.strikePrice);
  const spot    = chain.underlyingValue;

  // ── OI zone detection (top CE OI = resistance, top PE OI = support) ──
  const ceRows = records.filter(r => r.CE?.openInterest).sort((a, b) => (b.CE!.openInterest - a.CE!.openInterest));
  const peRows = records.filter(r => r.PE?.openInterest).sort((a, b) => (b.PE!.openInterest - a.PE!.openInterest));

  const topCe = ceRows.slice(0, 5);
  const topPe = peRows.slice(0, 5);

  const strongResistance: OiZone[] = topCe.map((r, i) => ({
    strike:        r.strikePrice,
    type:          'resistance',
    strength:      i === 0 ? 'Strong' : i < 3 ? 'Moderate' : 'Weak',
    oi:            r.CE!.openInterest,
    oiChange:      r.CE!.changeinOpenInterest,
    interpretation: i === 0
      ? `Maximum call writing at ${r.strikePrice} — strong resistance. Price may face selling pressure here.`
      : `Call writing cluster at ${r.strikePrice} — resistance zone.`,
  }));

  const strongSupport: OiZone[] = topPe.map((r, i) => ({
    strike:        r.strikePrice,
    type:          'support',
    strength:      i === 0 ? 'Strong' : i < 3 ? 'Moderate' : 'Weak',
    oi:            r.PE!.openInterest,
    oiChange:      r.PE!.changeinOpenInterest,
    interpretation: i === 0
      ? `Maximum put writing at ${r.strikePrice} — strong support. Bulls defending this level.`
      : `Put writing at ${r.strikePrice} — support zone.`,
  }));

  // ── Build-up detection ─────────────────────────────────────────
  const buildups: BuildupSignal[] = [];
  for (const row of records) {
    if (row.CE && Math.abs(row.CE.changeinOpenInterest) > 50000) {
      const btype = classifyBuildup(row.CE.changeinOpenInterest, row.CE.lastPrice > 0 ? 1 : -1, 'CE');
      buildups.push({
        strike: row.strikePrice, optionType: 'CE', buildupType: btype,
        label: BUILD_LABELS[btype], description: BUILD_DESC[btype],
        oi: row.CE.openInterest, oiChange: row.CE.changeinOpenInterest,
        priceChange: row.CE.lastPrice,
      });
    }
    if (row.PE && Math.abs(row.PE.changeinOpenInterest) > 50000) {
      const btype = classifyBuildup(row.PE.changeinOpenInterest, row.PE.lastPrice > 0 ? 1 : -1, 'PE');
      buildups.push({
        strike: row.strikePrice, optionType: 'PE', buildupType: btype,
        label: BUILD_LABELS[btype], description: BUILD_DESC[btype],
        oi: row.PE.openInterest, oiChange: row.PE.changeinOpenInterest,
        priceChange: row.PE.lastPrice,
      });
    }
  }

  // ── Trap zone (between big CE and PE OI strikes near spot) ───────
  const trapZones: TrapZone[] = [];
  const nearRes = strongResistance.find(z => z.strike > spot && z.strike - spot < spot * 0.02);
  const nearSup = strongSupport.find(z => z.strike < spot && spot - z.strike < spot * 0.02);
  if (nearRes && nearSup) {
    trapZones.push({
      lower:       nearSup.strike,
      upper:       nearRes.strike,
      description: `Price trapped between put support at ${nearSup.strike} and call resistance at ${nearRes.strike}. Range-bound until one breaks.`,
      severity:    'High',
    });
  }

  // ── PCR (Put-Call Ratio) ─────────────────────────────────────────
  const totalPeOi = records.reduce((s, r) => s + (r.PE?.openInterest ?? 0), 0);
  const totalCeOi = records.reduce((s, r) => s + (r.CE?.openInterest ?? 0), 0);
  const pcr        = totalCeOi > 0 ? parseFloat((totalPeOi / totalCeOi).toFixed(2)) : 1;
  const pcrLabel   = pcr > 1.3 ? 'Bullish (PCR > 1.3)' : pcr < 0.7 ? 'Bearish (PCR < 0.7)' : 'Neutral';

  // ── Max Pain ──────────────────────────────────────────────────────
  const strikes = Array.from(new Set(records.map(r => r.strikePrice))).sort((a, b) => a - b);
  let maxPain   = spot;
  let minPain   = Infinity;
  for (const s of strikes) {
    const pain = records.reduce((sum, r) => {
      const cePain = r.CE ? Math.max(0, s - r.strikePrice) * r.CE.openInterest : 0;
      const pePain = r.PE ? Math.max(0, r.strikePrice - s) * r.PE.openInterest : 0;
      return sum + cePain + pePain;
    }, 0);
    if (pain < minPain) { minPain = pain; maxPain = s; }
  }

  // ── Expected move (using ATM IV) ──────────────────────────────────
  const atmRow   = records.reduce((best, r) => Math.abs(r.strikePrice - spot) < Math.abs(best.strikePrice - spot) ? r : best, records[0]);
  const atmStrike = atmRow?.strikePrice ?? spot;
  const atmIv    = ((atmRow?.CE?.impliedVolatility ?? 0) + (atmRow?.PE?.impliedVolatility ?? 0)) / 2;
  const daysLeft = 7; // approximate
  const moveAmt  = atmIv > 0 ? spot * (atmIv / 100) * Math.sqrt(daysLeft / 365) : spot * 0.01;
  const expectedMoveUp   = parseFloat((spot + moveAmt).toFixed(0));
  const expectedMoveDown = parseFloat((spot - moveAmt).toFixed(0));

  // ── IV context ────────────────────────────────────────────────────
  const ivContext = atmIv > 30 ? 'High volatility — options expensive, prefer selling strategies'
    : atmIv > 15 ? 'Moderate volatility — balanced premium'
    : 'Low volatility — options cheap, consider buying strategies';

  const chainRows: OptionChainViewRow[] = records.map((row) => ({
    strikePrice: row.strikePrice,
    expiryDate: row.expiryDate,
    ceOi: row.CE?.openInterest ?? 0,
    ceOiChange: row.CE?.changeinOpenInterest ?? 0,
    ceIv: row.CE?.impliedVolatility ?? 0,
    ceLtp: row.CE?.lastPrice ?? 0,
    ceVolume: row.CE?.totalTradedVolume ?? 0,
    ceBid: row.CE?.bidprice ?? 0,
    ceAsk: row.CE?.askPrice ?? 0,
    peOi: row.PE?.openInterest ?? 0,
    peOiChange: row.PE?.changeinOpenInterest ?? 0,
    peIv: row.PE?.impliedVolatility ?? 0,
    peLtp: row.PE?.lastPrice ?? 0,
    peVolume: row.PE?.totalTradedVolume ?? 0,
    peBid: row.PE?.bidprice ?? 0,
    peAsk: row.PE?.askPrice ?? 0,
  }));

  const ceIvs = chainRows.map((r) => r.ceIv).filter((n) => n > 0);
  const peIvs = chainRows.map((r) => r.peIv).filter((n) => n > 0);
  const avgCeIv = avg(ceIvs);
  const avgPeIv = avg(peIvs);
  const metrics: OptionMetrics = {
    totalCeOi,
    totalPeOi,
    totalCeVolume: sum(chainRows.map((r) => r.ceVolume)),
    totalPeVolume: sum(chainRows.map((r) => r.peVolume)),
    atmStrike,
    atmIv: round2(atmIv),
    avgIv: round2(avg([...ceIvs, ...peIvs])),
    ivSkew: round2(avgPeIv - avgCeIv),
    highestCeOiStrike: strongResistance[0]?.strike ?? null,
    highestPeOiStrike: strongSupport[0]?.strike ?? null,
    chainRows: chainRows.length,
  };

  const optionSignals = buildOptionSignals({
    pcr,
    pcrLabel,
    maxPain,
    spot,
    resistance: strongResistance,
    support: strongSupport,
    buildups: buildups.slice(0, 10),
    ivContext,
  });

  // ── Summary ───────────────────────────────────────────────────────
  const topRes = strongResistance[0];
  const topSup = strongSupport[0];
  const summary = [
    topRes ? `Strong resistance at ${topRes.strike} (heavy call writing).` : '',
    topSup ? `Strong support at ${topSup.strike} (put writing defense).` : '',
    `PCR at ${pcr} signals ${pcrLabel.toLowerCase()} sentiment.`,
    `Max pain at ${maxPain}. Expected weekly move: ${expectedMoveDown}–${expectedMoveUp}.`,
    trapZones.length ? `Range-bound trap: ${trapZones[0].lower}–${trapZones[0].upper}.` : '',
  ].filter(Boolean).join(' ');

  const intel: OptionIntelligence = {
    symbol: resolvedSymbol,
    requestedSymbol: chain.requestedSymbol,
    underlyingValue: spot,
    expiryDate: expiry,
    strongResistance, strongSupport, buildups: buildups.slice(0, 10),
    trapZones, expectedMoveUp, expectedMoveDown,
    pcr, pcrLabel, maxPain, ivContext, summary,
    generatedAt: new Date().toISOString(),
    dataSource:  normalizeDataSource(chain.source),
    expiryDates: chain.expiryDates,
    chain: chainRows,
    metrics,
    optionSignals,
  };

  const cacheTtl = intel.dataSource === 'synthetic' ? 60 : 120; // synthetic: 1 min, live: 2 min
  await cacheSet(cacheKey, intel, cacheTtl);
  return intel;
}
