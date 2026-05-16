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

export interface TrapZone {
  lower:       number;
  upper:       number;
  description: string;
  severity:    'High' | 'Medium';
}

export interface OptionIntelligence {
  symbol:           string;
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

export async function analyzeOptionChain(symbol: string, expiryIndex = 0): Promise<OptionIntelligence | null> {
  const cacheKey = `optintel:${symbol}`;
  const cached   = await cacheGet<OptionIntelligence>(cacheKey);
  if (cached) return cached;

  const chain = await fetchOptionChain(symbol);
  if (!chain || !chain.records.length) return null;

  const expiry  = chain.expiryDates[expiryIndex] ?? chain.expiryDates[0];
  const records = chain.records.filter(r => r.expiryDate === expiry);
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
  const atmIv    = ((atmRow?.CE?.impliedVolatility ?? 0) + (atmRow?.PE?.impliedVolatility ?? 0)) / 2;
  const daysLeft = 7; // approximate
  const moveAmt  = atmIv > 0 ? spot * (atmIv / 100) * Math.sqrt(daysLeft / 365) : spot * 0.01;
  const expectedMoveUp   = parseFloat((spot + moveAmt).toFixed(0));
  const expectedMoveDown = parseFloat((spot - moveAmt).toFixed(0));

  // ── IV context ────────────────────────────────────────────────────
  const ivContext = atmIv > 30 ? 'High volatility — options expensive, prefer selling strategies'
    : atmIv > 15 ? 'Moderate volatility — balanced premium'
    : 'Low volatility — options cheap, consider buying strategies';

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
    symbol, underlyingValue: spot, expiryDate: expiry,
    strongResistance, strongSupport, buildups: buildups.slice(0, 10),
    trapZones, expectedMoveUp, expectedMoveDown,
    pcr, pcrLabel, maxPain, ivContext, summary,
    generatedAt: new Date().toISOString(),
    dataSource:  (chain.source ?? 'live') as 'live' | 'synthetic' | 'unknown',
  };

  const cacheTtl = intel.dataSource === 'synthetic' ? 60 : 120; // synthetic: 1 min, live: 2 min
  await cacheSet(cacheKey, intel, cacheTtl);
  return intel;
}
