/**
 * Phase 1 — Data quality, lineage, determinism acceptance tests.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { buildSignalFeatures, buildSignalFeaturesDetailed } from '@/lib/signal-engine/features/buildSignalFeatures';
import { fingerprintSignalFeatures } from '@/lib/signal-engine/features/featureFingerprint';
import { scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import { runAllStrategies } from '@/lib/signal-engine/strategy-engine/runStrategies';
import { validateCandleSeriesIntegrity } from '@/lib/marketData/integrity/marketDataIntegrity';
import {
  buildCanonicalInputSnapshot,
  freezeSnapshotForReplay,
  hashCandleSeries,
  CANONICAL_INPUT_SNAPSHOT_VERSION,
} from '@/lib/signal-engine/lineage/canonicalInputSnapshot';
import { evaluateDataQualityDecision, applyDataQualityConfidenceModifier } from '@/lib/signal-engine/lineage/dataQualityDecision';
import { buildCorporateActionFields, isStructureStrategyBlocked } from '@/lib/signal-engine/lineage/corporateActionGuard';
import {
  getDataQualityRejectionCounts,
  recordDataQualityRejection,
  resetDataQualityRejectionCounts,
} from '@/lib/signal-engine/lineage/dqCounters';
import { getSignalEngineConfig, resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import type { Candle, RelativeStrengthFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const RS: RelativeStrengthFeatures = { rsVsIndex: 1.5, rsVsSector: 0.5, sectorStrengthScore: 55 };

function syntheticCandles(n = 100, startClose = 200): Candle[] {
  const out: Candle[] = [];
  let close = startClose;
  for (let i = 0; i < n; i++) {
    close += (i % 5 === 0 ? 1.5 : -0.3);
    const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    out.push({
      ts: `2024-${month}-${day}`,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 800_000,
    });
  }
  return out;
}

describe('Phase 1 — canonical input snapshot contract', () => {
  it('builds versioned snapshot with lineage + hashes + features', () => {
    const candles = syntheticCandles(90);
    const features = buildSignalFeatures(candles, 'Sideways');
    const integrity = validateCandleSeriesIntegrity(candles, { nowMs: Date.parse('2024-12-01') });
    const corporate = buildCorporateActionFields(integrity.issues, { mode: 'adjusted' });
    const dq = evaluateDataQualityDecision({
      issues: integrity.issues,
      freshnessStatus: 'fresh',
    });
    const snap = buildCanonicalInputSnapshot({
      symbol: 'RELIANCE',
      candles: integrity.candles,
      features,
      integrityIssues: integrity.issues,
      freshnessStatus: 'fresh',
      dataQuality: dq,
      corporateAction: corporate,
      provider: {
        provider_identity: 'zerodha_kite',
        session_identity: null,
        resolution_path: 'kite→yahoo|nse|db',
        candle_source: 'market_data_daily',
        data_timestamp_iso: candles[candles.length - 1].ts,
      },
      config: getSignalEngineConfig(),
    });
    expect(snap.contract_version).toBe(CANONICAL_INPUT_SNAPSHOT_VERSION);
    expect(snap.candle_series_hash).toBe(hashCandleSeries(integrity.candles));
    expect(snap.provider.provider_identity).toBe('zerodha_kite');
    expect(snap.feature_vector).toEqual(features);
    expect(snap.corporate_action.price_adjustment_mode).toBe('adjusted');
  });
});

describe('Phase 1 — deterministic feature generation (1000 frozen snapshots)', () => {
  beforeEach(() => {
    resetSignalEngineConfigCache();
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '1';
    resetSignalEngineConfigCache();
  });

  it('replaying 1000 frozen windows yields byte-equivalent features, matches, confidence', () => {
    const base = syntheticCandles(120);
    const nowMs = Date.parse('2024-06-15T12:00:00Z');
    const fingerprints: string[] = [];
    const confidences: number[] = [];
    const matchKeys: string[] = [];

    for (let i = 0; i < 1000; i++) {
      const window = base.map((c) => ({ ...c }));
      const built = buildSignalFeaturesDetailed(window, 'Sideways', undefined, undefined, {
        nowMs,
        integrity: { nowMs, minWarmupBars: 80 },
      });
      const fp = fingerprintSignalFeatures(built.features);
      const conf = scoreConfidenceForStrategy(built.features, 'bullish_pullback', RS);
      const { candidates } = runAllStrategies(built.features, RS);
      fingerprints.push(fp);
      confidences.push(conf.finalScore);
      matchKeys.push(candidates.map((c) => c.strategy).sort().join(','));
    }

    // All 1000 identical
    expect(new Set(fingerprints).size).toBe(1);
    expect(new Set(confidences).size).toBe(1);
    expect(new Set(matchKeys).size).toBe(1);

    // Second pass (parity / backtest-style) equals first
    const again = buildSignalFeaturesDetailed(base, 'Sideways', undefined, undefined, {
      nowMs,
      integrity: { nowMs, minWarmupBars: 80 },
    });
    expect(fingerprintSignalFeatures(again.features)).toBe(fingerprints[0]);
    expect(freezeSnapshotForReplay(
      buildCanonicalInputSnapshot({
        symbol: 'TCS',
        candles: again.candlesUsed,
        features: again.features,
        integrityIssues: again.integrityIssues,
        freshnessStatus: 'fresh',
        dataQuality: evaluateDataQualityDecision({
          issues: again.integrityIssues,
          freshnessStatus: 'fresh',
        }),
        corporateAction: buildCorporateActionFields(again.integrityIssues),
        provider: {
          provider_identity: 'zerodha_kite',
          session_identity: null,
          resolution_path: 'kite',
          candle_source: 'fixture',
          data_timestamp_iso: again.candlesUsed.at(-1)?.ts ?? null,
        },
      }),
    ).length).toBeGreaterThan(100);
  });
});

describe('Phase 1 — corporate-action guard', () => {
  it('blocks fibonacci/structure strategies on unexplained split discontinuity', () => {
    const candles = syntheticCandles(90);
    // Inject split-like jump
    const last = candles[candles.length - 1];
    candles[candles.length - 1] = { ...last, open: last.close * 0.4, high: last.close * 0.45, low: last.close * 0.35, close: last.close * 0.4 };
    const integrity = validateCandleSeriesIntegrity(candles, { nowMs: Date.parse('2024-12-01') });
    expect(integrity.issues.some((i) => i.code === 'SPLIT_ANOMALY')).toBe(true);
    const corporate = buildCorporateActionFields(integrity.issues);
    expect(corporate.unexplained_discontinuity).toBe(true);
    expect(isStructureStrategyBlocked('fibonacci_pullback', corporate)).toBe(true);

    const features = buildSignalFeatures(integrity.candles.length ? integrity.candles : candles, 'Bullish');
    const { rejections } = runAllStrategies(features, RS, { corporateAction: corporate });
    expect(rejections.some((r) => r.strategy === 'fibonacci_pullback' && /Corporate-action/.test(r.reason))).toBe(true);
  });
});

describe('Phase 1 — data quality gate influence', () => {
  it('critical incomplete candle rejects before strategies conceptually', () => {
    const d = evaluateDataQualityDecision({
      issues: [],
      freshnessStatus: 'fresh',
      incompleteCurrent: true,
    });
    expect(d.severity).toBe('critical');
    expect(d.rejectBeforeStrategies).toBe(true);
    expect(d.actionable).toBe(false);
  });

  it('minor issue applies a single confidence modifier', () => {
    const d = evaluateDataQualityDecision({
      issues: [{ code: 'ZERO_VOLUME', message: 'zero' }],
      freshnessStatus: 'fresh',
      minorModifierPts: 5,
    });
    expect(d.severity).toBe('minor');
    expect(applyDataQualityConfidenceModifier(80, d)).toBe(75);
  });
});

describe('Phase 1 — DQ counters by reason × provider', () => {
  beforeEach(() => resetDataQualityRejectionCounts());

  it('records and lists counters', () => {
    recordDataQualityRejection('INCOMPLETE_CURRENT_CANDLE', 'kite');
    recordDataQualityRejection('INCOMPLETE_CURRENT_CANDLE', 'kite');
    recordDataQualityRejection('MISSING_SESSIONS', 'yahoo');
    const rows = getDataQualityRejectionCounts();
    expect(rows.find((r) => r.reason === 'INCOMPLETE_CURRENT_CANDLE' && r.provider === 'kite')?.count).toBe(2);
    expect(rows.find((r) => r.provider === 'yahoo')?.count).toBe(1);
  });
});

describe('Phase 1 — incomplete candle never actionable', () => {
  it('integrity marks incomplete current as fatal when enabled', () => {
    const candles = syntheticCandles(90);
    candles[candles.length - 1] = { ...candles[candles.length - 1], ts: '2024-06-15' };
    const result = validateCandleSeriesIntegrity(candles, {
      nowMs: Date.parse('2024-06-15T10:00:00Z'),
      rejectIncompleteCurrent: true,
      asOfDay: '2024-06-15',
      minWarmupBars: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'INCOMPLETE_CURRENT_CANDLE')).toBe(true);
  });
});

describe('Phase 1 — backtest/production feature parity', () => {
  it('same candles + nowMs → identical fingerprints across builders', () => {
    const candles = syntheticCandles(100);
    const nowMs = 1_700_000_000_000;
    const a = buildSignalFeaturesDetailed(candles, 'Bullish', undefined, undefined, { nowMs });
    const b = buildSignalFeaturesDetailed(candles.map((c) => ({ ...c })), 'Bullish', undefined, undefined, { nowMs });
    expect(fingerprintSignalFeatures(a.features)).toBe(fingerprintSignalFeatures(b.features));
  });
});
