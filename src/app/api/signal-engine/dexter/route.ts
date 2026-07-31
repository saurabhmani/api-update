// ════════════════════════════════════════════════════════════════
//  GET /api/signal-engine/dexter
//
//  Dexter AI — Live Signal Intelligence
//
//  Computes narratives LIVE by running the real context engines:
//    - fetchLiveNewsContext() → real news data per symbol
//    - buildMacroContext()    → regime-derived market tone
//    - computeEventRisk()     → event risk from news tags
//    - computeContextualModifiers() → bounded ±10 adjustments
//    - loadLiveFeedbackState() → strategy performance from DB
//
//  This ensures data always flows through the real engines,
//  not from potentially empty snapshot tables.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { buildDexterNarrative, type DexterSignalIntelligence } from '@/lib/signal-engine/dexter/buildDexterNarrative';
import { fetchLiveNewsContext, computeEventRisk } from '@/lib/signal-engine/context/macroContext';
import { computeContextualModifiers } from '@/lib/signal-engine/context/contextualModifiers';
import { loadLiveFeedbackState } from '@/lib/signal-engine/repository/savePhase4Artifacts';
import { computeFreshness } from '@/lib/signal-engine/freshness/signalDecay';
import { withApiHandler } from '@/lib/apiHandler';
import { cacheService } from '@/lib/cache/cacheService';
import { cacheKeys } from '@/lib/cache/cacheKeys';
import { CACHE_POLICIES } from '@/lib/cache/cachePolicy';
import {
  createRequestStageProfiler,
  type RequestStageProfiler,
} from '@/lib/api/requestStageProfiler';
import type {
  Phase4SignalEnvelope,
  MacroContext,
  NewsContext,
  EventRiskSnapshot,
  FeedbackState,
  EventTag,
  MarketTone,
  RiskMode,
} from '@/lib/signal-engine/types/phase4.types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function handleDexterGet(req: NextRequest, profile: RequestStageProfiler) {
  let userId: number;
  try {
    const user = await profile.time('authentication', () => requireSession());
    userId = user.id;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const validationStartedAt = performance.now();
    const rawDays = Number(req.nextUrl.searchParams.get('days') || '7');
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(30, Math.floor(rawDays))) : 7;
    const rawSymbol = req.nextUrl.searchParams.get('symbol')?.trim().toUpperCase() ?? null;
    const symbolFilter = rawSymbol && /^[A-Z0-9&.-]{1,30}$/.test(rawSymbol) ? rawSymbol : null;
    const rawConviction = req.nextUrl.searchParams.get('conviction');
    const convictionFilter = rawConviction && ['high', 'moderate', 'low', 'avoid'].includes(rawConviction)
      ? rawConviction
      : null;
    profile.mark('request_validation', performance.now() - validationStartedAt);

    const responseCacheKey = cacheKeys.dexterIntelligence(
      userId, days, symbolFilter, convictionFilter,
    );
    const bypassCache = req.nextUrl.searchParams.get('noCache') === 'true';
    const cached = bypassCache ? null : await profile.time(
      'cache_lookup',
      () => cacheService.get<Record<string, unknown>>(responseCacheKey),
    );
    if (cached) {
      profile.setCache('hit');
      return NextResponse.json(cached, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    profile.setCache(bypassCache ? 'bypass' : 'miss');

    // ── Load signals ────────────────────────────────────────────
    const symbolClause = symbolFilter ? 'AND s.symbol = ?' : '';
    const params: any[] = [days];
    if (symbolFilter) params.push(symbolFilter);

    const { rows: signalRows } = await profile.time('signals_loading', () => db.query(
      `SELECT s.id, s.symbol, s.signal_type, s.direction,
              s.confidence_score, s.confidence_band,
              s.risk_score, s.risk_band,
              s.market_regime, s.entry_price, s.stop_loss,
              s.target1, s.target2, s.risk_reward,
              s.generated_at, s.sector, s.volatility_state
         FROM q365_signals s
        WHERE s.generated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ${symbolClause}
        ORDER BY s.generated_at DESC
        LIMIT 100`,
      params,
    ), (result) => ({ rows: result.rows.length }));

    const signals = signalRows as any[];
    if (signals.length === 0) {
      const emptyPayload = {
        intelligence: [],
        meta: { lookbackDays: days, signalsAnalyzed: 0, generatedAt: new Date().toISOString() },
      };
      if (!bypassCache) {
        await profile.time('cache_write', () => cacheService.set(
          responseCacheKey, emptyPayload, CACHE_POLICIES.dexterEmpty,
        ));
      }
      return NextResponse.json(emptyPayload);
    }

    // ── Batch-fetch explanations for AI guidance/risk text ──────
    const ids = signals.map((r: any) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const { rows: explRows } = await profile.time('AI_context_loading', () => db.query(
      `SELECT signal_id, explanation_json FROM q365_signal_explanations WHERE signal_id IN (${placeholders})`,
      ids,
    ), (result) => ({ rows: result.rows.length }));
    const explBySignal = new Map<number, any>();
    for (const r of explRows as any[]) explBySignal.set(Number(r.signal_id), safeJsonParse(r.explanation_json, {}));

    // ── Batch-fetch signal reasons ──────────────────────────────
    let reasonsBySignal = new Map<number, string[]>();
    let warningsBySignal = new Map<number, string[]>();
    try {
      const { rows: reasonRows } = await profile.time('AI_context_loading', () => db.query(
        `SELECT signal_id, reason_type, message FROM q365_signal_reasons WHERE signal_id IN (${placeholders}) ORDER BY id`,
        ids,
      ), (result) => ({ rows: result.rows.length }));
      for (const r of reasonRows as any[]) {
        const sid = Number(r.signal_id);
        if (r.reason_type === 'warning') {
          const list = warningsBySignal.get(sid) ?? [];
          list.push(r.message);
          warningsBySignal.set(sid, list);
        } else {
          const list = reasonsBySignal.get(sid) ?? [];
          list.push(r.message);
          reasonsBySignal.set(sid, list);
        }
      }
    } catch { /* table may not exist */ }

    // ── Build macro context from most common regime + sector leadership ──
    const regimeCounts: Record<string, number> = {};
    const sectorCounts: Record<string, number> = {};
    for (const sig of signals) {
      const r = sig.market_regime ?? 'NEUTRAL';
      regimeCounts[r] = (regimeCounts[r] ?? 0) + 1;
      const sec = sig.sector;
      if (sec) sectorCounts[sec] = (sectorCounts[sec] ?? 0) + 1;
    }
    const dominantRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NEUTRAL';
    // Sectors with 2+ signals = leadership
    const leadingSectors = Object.entries(sectorCounts)
      .filter(([, count]) => count >= 2)
      .map(([sector]) => sector);
    const macro = buildMacroFromRegime(dominantRegime);
    macro.sectorLeadership = leadingSectors;

    // Deduplicate context reads before narrative construction. News is
    // loaded once per symbol and feedback once per strategy/regime pair;
    // the loop below performs no provider or database awaits.
    const newsBySymbol = new Map<string, Promise<NewsContext>>();
    const feedbackByIdentity = new Map<string, Promise<FeedbackState>>();
    for (const sig of signals) {
      if (!newsBySymbol.has(sig.symbol)) {
        newsBySymbol.set(sig.symbol, fetchLiveNewsContext(sig.symbol).catch(() => ({
          bias: 'neutral', strength: 0, freshnessHours: 999,
          sourceConfidence: 0, eventTags: [], headline: null,
        })));
      }
      const identity = `${sig.signal_type ?? 'unknown'}|${sig.market_regime ?? 'NEUTRAL'}`;
      if (!feedbackByIdentity.has(identity)) {
        feedbackByIdentity.set(identity, loadLiveFeedbackState(
          sig.signal_type ?? 'unknown', sig.market_regime ?? 'NEUTRAL',
        ).catch(() => ({
          strategyRecentWinRate: null,
          strategyEnvironmentFit: 'insufficient_data',
          confidenceCalibrationState: 'insufficient_data',
        })));
      }
    }
    await profile.time('AI_context_loading', () => Promise.all([
      ...newsBySymbol.values(), ...feedbackByIdentity.values(),
    ]), () => ({
      calls: newsBySymbol.size + feedbackByIdentity.size,
      providerCalls: newsBySymbol.size,
    }));

    // ── Build Dexter intelligence per signal (LIVE computation) ──
    const processingStartedAt = performance.now();
    const intelligence: DexterSignalIntelligence[] = [];

    for (const sig of signals) {
      const confidence = Number(sig.confidence_score ?? 0);
      const riskScore = Number(sig.risk_score ?? 50);
      const strategy = sig.signal_type ?? 'unknown';

      // 1. Fetch LIVE news context for this symbol
      const news = await newsBySymbol.get(sig.symbol)!;

      // 2. Compute event risk from news tags
      const eventTags: EventTag[] = (news.eventTags?.length > 0 ? news.eventTags : ['none']) as EventTag[];
      const eventRisk = computeEventRisk(eventTags, news.strength);

      // 3. Compute freshness
      const entry = Number(sig.entry_price ?? 0);
      let freshness;
      try {
        freshness = computeFreshness(sig.generated_at, entry, entry, 0);
      } catch {
        freshness = { ageBars: 0, ageHours: 0, freshnessScore: 100, decayState: 'fresh' as const, urgencyTag: 'normal' as const, priceDriftPct: 0 };
      }

      // 4. Load LIVE feedback state from learning loop
      const feedback = await feedbackByIdentity.get(
        `${strategy}|${sig.market_regime ?? 'NEUTRAL'}`,
      )!;

      // 5. Compute contextual modifiers (the REAL engine)
      const sectorInLeadership = macro.sectorLeadership.length > 0;
      const modifiers = computeContextualModifiers(
        confidence, macro, news, eventRisk, freshness, feedback, sectorInLeadership,
      );

      // 6. Get explanation text from persisted data (for guidance/risk bullets)
      const explJson = explBySignal.get(sig.id) ?? {};
      const reasons = reasonsBySignal.get(sig.id) ?? explJson.reasons ?? [];
      const warnings = warningsBySignal.get(sig.id) ?? explJson.warnings ?? [];

      // 7. Build the envelope for Dexter
      const envelope: Phase4SignalEnvelope = {
        symbol: sig.symbol,
        signalType: strategy,
        signalSubtype: 'primary',
        marketRegime: sig.market_regime ?? 'NEUTRAL',
        confidenceScore: confidence,
        adjustedConfidenceScore: modifiers.finalAdjustedConfidence,
        confidenceBand: modifiers.finalAdjustedConfidence >= 85 ? 'High Conviction'
          : modifiers.finalAdjustedConfidence >= 70 ? 'Actionable'
          : modifiers.finalAdjustedConfidence >= 55 ? 'Watchlist' : 'Avoid',
        riskScore,
        tradePlan: {
          entryZoneLow: entry,
          entryZoneHigh: entry,
          stopLoss: Number(sig.stop_loss ?? 0),
          target1: Number(sig.target1 ?? 0),
          target2: Number(sig.target2 ?? 0),
          target3: 0,
          rrTarget1: Number(sig.risk_reward ?? 0),
          rrTarget2: 0, rrTarget3: 0,
          initialRiskPerUnit: Math.abs(entry - Number(sig.stop_loss ?? 0)),
          entryType: 'breakout_confirmation',
        } as any,
        positionSizing: { positionSizeUnits: 0 } as any,
        portfolioFit: { fitScore: sectorInLeadership ? 75 : 50 } as any,
        executionReadiness: { approvalDecision: 'approved' } as any,
        macroContext: macro,
        newsContext: news,
        eventRisk,
        contextualModifiers: modifiers,
        aiExplanation: {
          summary: explJson.summary ?? reasons[0] ?? `${strategy} setup for ${sig.symbol}`,
          whyNow: explJson.whyNow ?? '',
          decisionNarrative: explJson.decisionNarrative ?? '',
          traderGuidance: explJson.traderGuidance ?? (reasons.length > 0 ? reasons.slice(0, 3) : [`Monitor ${sig.symbol} for entry confirmation`]),
          riskHighlights: explJson.riskHighlights ?? warnings.slice(0, 3),
          whatWouldInvalidate: explJson.whatWouldInvalidate ?? [`Close below ${sig.stop_loss} invalidates the setup`],
          whyNotOversize: explJson.whyNotOversize ?? '',
        },
        traderNarrative: { shortSummary: '', fullNarrative: '', guidanceBullets: [], invalidationSummary: '' },
        freshness,
        feedbackState: feedback,
        lifecycleStatus: 'active',
        // Phase-4 scoring — read from persisted columns when available
        // (post-Phase-4 rows). Legacy rows fall back to the dynamic
        // ranker's `final_score` and a neutral classification so the
        // dexter narrative still renders.
        final_score: Number(
          (sig as any).composite_final_score ?? (sig as any).final_score ?? 0,
        ),
        classification:
          ((sig as any).classification as Phase4SignalEnvelope['classification']) ??
          'VALID_SIGNAL',
        factor_scores: {
          strategy_quality:    confidence,
          trend_alignment:     0,
          momentum:            0,
          volume_confirmation: 0,
          risk_reward:         0,
          liquidity:           0,
          market_regime:       0,
          portfolio_fit:       Number((sig as any).portfolio_fit_score ?? 0),
        },
        reasons,
        warnings,
        generatedAt: sig.generated_at,
      };

      const dexter = buildDexterNarrative(envelope);

      if (convictionFilter && dexter.conviction !== convictionFilter) continue;
      intelligence.push(dexter);
    }
    profile.mark('Dexter_response_processing', performance.now() - processingStartedAt, {
      calls: signals.length,
      rows: intelligence.length,
      providerCalls: 0,
    });

    const payload = {
      intelligence,
      meta: {
        lookbackDays: days,
        signalsAnalyzed: intelligence.length,
        generatedAt: new Date().toISOString(),
        regimeDetected: dominantRegime,
        marketTone: macro.marketTone,
      },
    };
    if (!bypassCache) {
      await profile.time('cache_write', () => cacheService.set(
        responseCacheKey, payload, CACHE_POLICIES.dexterIntelligence,
      ));
    }
    const serializationStartedAt = performance.now();
    const response = NextResponse.json(payload);
    profile.mark('serialization', performance.now() - serializationStartedAt);
    return response;
  } catch (err) {
    console.error('[dexter]', err);
    return NextResponse.json(
      { error: 'Dexter intelligence generation failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = withApiHandler(async (req: NextRequest) => {
  const requestId = req.headers.get('X-Request-ID') ?? `dexter-${Date.now().toString(36)}`;
  const profile = createRequestStageProfiler({
    route: '/api/signal-engine/dexter', method: 'GET', requestId,
  });
  const response = await handleDexterGet(req, profile);
  await profile.finish(response);
  return response;
});

// ── Helpers ──────────────────────────────────────────────────

function safeJsonParse(val: unknown, fallback: any): any {
  if (!val) return fallback;
  if (typeof val === 'object' && val !== null) return val;
  try { return JSON.parse(String(val)); } catch { return fallback; }
}

function buildMacroFromRegime(regime: string): MacroContext {
  const toneMap: Record<string, MarketTone> = {
    STRONG_BULL: 'strongly_constructive', BULL: 'constructive',
    SIDEWAYS: 'neutral', NEUTRAL: 'neutral',
    WEAK: 'cautious', BEARISH: 'hostile', HIGH_VOL: 'cautious',
    'Strong Bullish': 'strongly_constructive', 'Bullish': 'constructive',
    'Sideways': 'neutral', 'Weak': 'cautious', 'Bearish': 'hostile',
    'High Volatility Risk': 'cautious',
  };
  const riskMap: Record<string, RiskMode> = {
    STRONG_BULL: 'risk_on', BULL: 'moderate_risk_on',
    SIDEWAYS: 'neutral', NEUTRAL: 'neutral',
    WEAK: 'risk_off', BEARISH: 'risk_off', HIGH_VOL: 'risk_off',
    'Strong Bullish': 'risk_on', 'Bullish': 'moderate_risk_on',
    'Sideways': 'neutral', 'Weak': 'risk_off', 'Bearish': 'risk_off',
    'High Volatility Risk': 'risk_off',
  };
  return {
    marketTone: toneMap[regime] ?? 'neutral',
    riskMode: riskMap[regime] ?? 'neutral',
    volatilityState: 'normal',
    sectorLeadership: [],
    macroEventProximity: 'none',
  };
}
