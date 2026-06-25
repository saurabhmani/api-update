import { db } from '@/lib/db';
import type { TrustRegimeSnapshot } from '../types';
import { getRegimeCategoryModifier } from '../services/regimeConfidence';

export async function persistRegimeSnapshot(snapshot: TrustRegimeSnapshot): Promise<void> {
  const modifier = getRegimeCategoryModifier(snapshot.category);
  const payload = [
    snapshot.label,
    snapshot.category,
    'NIFTY 50',
    snapshot.strength,
    snapshot.confidence,
    snapshot.allowBullishSignals,
    modifier,
    JSON.stringify({ ...snapshot.details, volatilityRegime: snapshot.volatilityRegime, source: snapshot.source }),
    snapshot.capturedAt,
  ];

  try {
    await db.query(
      `INSERT INTO market_regime
         (regime_label, regime_category, benchmark_symbol, strength, confidence,
          allow_bullish, confidence_modifier, details_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payload,
    );
  } catch {
    try {
      await db.query(
        `INSERT INTO q365_trust_regime_snapshots
           (regime_label, regime_category, benchmark_symbol, strength, confidence, details_json, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.label,
          snapshot.category,
          'NIFTY 50',
          snapshot.strength,
          snapshot.confidence,
          JSON.stringify({ ...snapshot.details, volatilityRegime: snapshot.volatilityRegime, source: snapshot.source }),
          snapshot.capturedAt,
        ],
      );
    } catch { /* migrations not applied */ }
  }
}

export async function getLatestMarketRegime(): Promise<TrustRegimeSnapshot | null> {
  try {
    const { rows } = await db.query(
      `SELECT regime_label, regime_category, strength, confidence, allow_bullish,
              details_json, computed_at
         FROM market_regime
        ORDER BY computed_at DESC
        LIMIT 1`,
    );
    if (!rows.length) return null;
    const r = rows[0] as Record<string, unknown>;
    const details = typeof r.details_json === 'string'
      ? JSON.parse(r.details_json)
      : (r.details_json as Record<string, number>) ?? {};
    return {
      label: String(r.regime_label),
      category: r.regime_category as TrustRegimeSnapshot['category'],
      allowBullishSignals: Boolean(r.allow_bullish),
      strength: Number(r.strength ?? 0),
      confidence: Number(r.confidence ?? 0),
      volatilityRegime: String(details.volatilityRegime ?? 'Normal'),
      trendSlope: Number(details.trendSlope ?? 0),
      details: {
        rsi: Number(details.rsi ?? 0),
        atrPct: Number(details.atrPct ?? 0),
        closeVsEma20: Number(details.closeVsEma20 ?? 0),
        closeVsEma50: Number(details.closeVsEma50 ?? 0),
      },
      source: (details.source as TrustRegimeSnapshot['source']) ?? 'index',
      capturedAt: String(r.computed_at ?? new Date().toISOString()),
    };
  } catch {
    return null;
  }
}
