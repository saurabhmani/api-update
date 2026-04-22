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
import { ensureSignalEngineSchemas } from '@/lib/signal-engine/repository/ensureSchemas';
import { buildDexterNarrative, type DexterSignalIntelligence } from '@/lib/signal-engine/dexter/buildDexterNarrative';
import { fetchLiveNewsContext, computeEventRisk } from '@/lib/signal-engine/context/macroContext';
import { computeContextualModifiers } from '@/lib/signal-engine/context/contextualModifiers';
import { loadLiveFeedbackState } from '@/lib/signal-engine/repository/savePhase4Artifacts';
import { computeFreshness } from '@/lib/signal-engine/freshness/signalDecay';
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

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await ensureSignalEngineSchemas();

    const days = Number(req.nextUrl.searchParams.get('days') || '7');
    const symbolFilter = req.nextUrl.searchParams.get('symbol');
    const convictionFilter = req.nextUrl.searchParams.get('conviction');

    // ── Load signals ────────────────────────────────────────────
    const symbolClause = symbolFilter ? 'AND s.symbol = ?' : '';
    const params: any[] = [days];
    if (symbolFilter) params.push(symbolFilter);

    const { rows: signalRows } = await db.query(
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
    );

    const signals = signalRows as any[];
    if (signals.length === 0) {
      return NextResponse.json({
        intelligence: [],
        meta: { lookbackDays: days, signalsAnalyzed: 0, generatedAt: new Date().toISOString() },
      });
    }

    // ── Batch-fetch explanations for AI guidance/risk text ──────
    const ids = signals.map((r: any) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const { rows: explRows } = await db.query(
      `SELECT signal_id, explanation_json FROM q365_signal_explanations WHERE signal_id IN (${placeholders})`,
      ids,
    );
    const explBySignal = new Map<number, any>();
    for (const r of explRows as any[]) explBySignal.set(Number(r.signal_id), safeJsonParse(r.explanation_json, {}));

    // ── Batch-fetch signal reasons ──────────────────────────────
    let reasonsBySignal = new Map<number, string[]>();
    let warningsBySignal = new Map<number, string[]>();
    try {
      const { rows: reasonRows } = await db.query(
        `SELECT signal_id, reason_type, message FROM q365_signal_reasons WHERE signal_id IN (${placeholders}) ORDER BY id`,
        ids,
      );
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

    // ── Build Dexter intelligence per signal (LIVE computation) ──
    const intelligence: DexterSignalIntelligence[] = [];

    for (const sig of signals) {
      const confidence = Number(sig.confidence_score ?? 0);
      const riskScore = Number(sig.risk_score ?? 50);
      const strategy = sig.signal_type ?? 'unknown';

      // 1. Fetch LIVE news context for this symbol
      let news: NewsContext;
      try {
        news = await fetchLiveNewsContext(sig.symbol);
      } catch {
        news = { bias: 'neutral', strength: 0, freshnessHours: 999, sourceConfidence: 0, eventTags: [], headline: null };
      }

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
      let feedback: FeedbackState;
      try {
        feedback = await loadLiveFeedbackState(strategy, sig.market_regime ?? 'NEUTRAL');
      } catch {
        feedback = { strategyRecentWinRate: null, strategyEnvironmentFit: 'insufficient_data', confidenceCalibrationState: 'insufficient_data' };
      }

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
        reasons,
        warnings,
        generatedAt: sig.generated_at,
      };

      const dexter = buildDexterNarrative(envelope);

      if (convictionFilter && dexter.conviction !== convictionFilter) continue;
      intelligence.push(dexter);
    }

    return NextResponse.json({
      intelligence,
      meta: {
        lookbackDays: days,
        signalsAnalyzed: intelligence.length,
        generatedAt: new Date().toISOString(),
        regimeDetected: dominantRegime,
        marketTone: macro.marketTone,
      },
    });
  } catch (err) {
    console.error('[dexter]', err);
    return NextResponse.json(
      { error: 'Dexter intelligence generation failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

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
