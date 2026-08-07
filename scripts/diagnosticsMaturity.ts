/**
 * Maturity / promotion funnel diagnostics.
 *
 *   npm run diagnostics:maturity
 *
 * Replays the same gates as signalMaturity.ts against mature trackers
 * joined to their current q365_signals rows. Never prints secrets.
 *
 * IMPORTANT: dotenv must load before maturityScorer — that module reads
 * MATURITY_* thresholds at import time.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolveEnvFilePath } from '@/lib/envPath';

const envFile = resolveEnvFilePath();
dotenvConfig({ path: envFile });
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

async function main(): Promise<void> {
  const { db } = await import('@/lib/db');
  const { MAIN_TABLE_CLASSIFICATIONS } = await import(
    '@/lib/signal-engine/pipeline/phase12Routing'
  );
  const {
    isPromotable,
    promotionRulesForStrategy,
    scoreMaturity,
  } = await import('@/lib/signal-engine/maturity/maturityScorer');
  type MaturityScorerOutput = import('@/lib/signal-engine/maturity/maturityScorer').MaturityScorerOutput;

  const SINCE = process.env.MATURITY_DIAG_SINCE || '2026-07-24';
  const SAMPLE_LIMIT = Math.max(5, Math.min(50, Number(process.env.MATURITY_DIAG_SAMPLE || 25)));

  type TrackerRow = {
    id: number;
    symbol: string;
    direction: 'BUY' | 'SELL';
    stage: string;
    maturity_score: number | null;
    validation_cycles_passed: number;
    stable: number | boolean | null;
    conviction_level: string | null;
    first_detected_at: Date | string | number;
    last_seen_at: Date | string | number;
    stability_history_json: string | null;
  };

  type SignalRow = {
    id: number;
    symbol: string;
    direction: string;
    generated_at: Date | string;
    confidence_score: number | null;
    final_score: number | null;
    composite_final_score: number | null;
    classification: string | null;
    signal_status: string | null;
    status: string | null;
    market_regime: string | null;
    market_stance: string | null;
    decay_state: string | null;
    factor_scores_json: unknown;
    phase4_factor_scores_json?: unknown;
    scenario_tag: string | null;
    entry_price: number | null;
    stop_loss: number | null;
    target1: number | null;
    target2: number | null;
    risk_reward: number | null;
    pct_change: number | null;
    live_valid: number | null;
    rejection_codes_json: unknown;
  };

  function toMs(v: Date | string | number | null | undefined): number {
    if (v == null) return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    if (v instanceof Date) return v.getTime();
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.getTime() : 0;
  }

  function num(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function numOrNull(v: unknown): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function parseObj(v: unknown): Record<string, unknown> | null {
    if (!v) return null;
    if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  function flattenNumericScores(
    obj: Record<string, unknown> | null,
    prefix = '',
  ): Array<{ key: string; value: number }> {
    if (!obj) return [];
    const out: Array<{ key: string; value: number }> = [];
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number' && Number.isFinite(v)) {
        out.push({ key, value: v });
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(...flattenNumericScores(v as Record<string, unknown>, key));
      }
    }
    return out;
  }

  function resolvePromotionClassification(row: SignalRow): string {
    const cls = String(row.classification ?? '').toUpperCase();
    if (MAIN_TABLE_CLASSIFICATIONS.has(cls)) return cls;
    const ss = String(row.signal_status ?? '').toUpperCase();
    if (ss === 'NO_TRADE') return cls;
    const composite = numOrNull(row.composite_final_score);
    if (composite != null && composite >= 50 && (cls === 'DEVELOPING_SETUP' || cls === '')) {
      return 'VALID_SIGNAL';
    }
    return cls;
  }

  function passesRegimeGate(result: MaturityScorerOutput): boolean {
    const factor = result.factors.find((f) => f.name === 'regime_alignment');
    if (!factor) return true;
    return factor.raw >= 0.5;
  }

  function simulateWriterGate(
    row: SignalRow,
    promotionCls: string,
    cycles: number,
    maturityScore: number,
  ): string | null {
    const ss = MAIN_TABLE_CLASSIFICATIONS.has(promotionCls)
      ? 'APPROVED_SIGNAL'
      : String(row.signal_status ?? '').toUpperCase();
    if (ss !== 'APPROVED_SIGNAL') return 'writer:not_approved';
    if (!MAIN_TABLE_CLASSIFICATIONS.has(promotionCls)) return 'writer:wrong_classification';
    if (row.live_valid === 0) return 'writer:live_invalid';
    const entry = num(row.entry_price);
    const stop = num(row.stop_loss);
    const t1 = num(row.target1);
    if (!(entry > 0 && stop > 0 && t1 > 0)) return 'writer:invalid_prices';
    const conf = num(row.confidence_score);
    const minConf = Number(process.env.PROMOTE_MIN_CONFIDENCE || 55);
    if (conf < minConf) return `writer:low_confidence(${conf}<${minConf})`;
    const final = numOrNull(row.composite_final_score) ?? numOrNull(row.final_score);
    const minFinal = Number(process.env.PROMOTE_MIN_FINAL_SCORE || 60);
    if (final != null && final < minFinal) return `writer:low_final_score(${final}<${minFinal})`;
    const minCycles = Number(process.env.PROMOTE_MIN_CYCLES || 2);
    if (cycles < minCycles) return `writer:low_cycles(${cycles}<${minCycles})`;
    const minMat = Number(process.env.PROMOTE_MIN_MATURITY || 70);
    if (!(maturityScore >= minMat)) return `writer:low_maturity(${maturityScore}<${minMat})`;
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(t1 - entry);
    if (!(risk > 0 && reward > 0)) return 'writer:invalid_plan';
    const rr = reward / risk;
    const minRr = Number(process.env.PROMOTE_MIN_RR || 1.5);
    if (rr < minRr) return `writer:low_rr(${rr.toFixed(2)}<${minRr})`;
    const edge = (reward / entry) * 100;
    const minEdge = Number(process.env.PROMOTE_MIN_EDGE_PCT || 1.0);
    if (!(edge > minEdge)) return `writer:no_edge(${edge.toFixed(2)}<=${minEdge})`;
    return null;
  }

  type DecisionRow = {
    signalId: number | null;
    symbol: string;
    direction: string;
    generatedAt: string | null;
    ageMin: number;
    trackerStage: string;
    cycles: number;
    rawConfidence: number;
    composite: number | null;
    finalScore: number | null;
    factorsPassing60: number;
    flatNumericCount: number;
    multiFactorRaw: number;
    classification: string;
    signalStatus: string;
    promotionCls: string;
    regime: string;
    maturityScore: number;
    vetoReason: string;
    decision: string;
    confluenceValuesSample: string;
  };

  console.log('════════════════════════════════════════════════════════════');
  console.log('  diagnostics:maturity');
  console.log(`  env_file=${envFile}`);
  console.log(`  since=${SINCE}`);
  console.log('════════════════════════════════════════════════════════════');

  const thresholdReport = {
    MATURITY_MATURE_THRESHOLD: process.env.MATURITY_MATURE_THRESHOLD ?? '(default 70)',
    MATURITY_PROMOTE_THRESHOLD: process.env.MATURITY_PROMOTE_THRESHOLD ?? '(default = mature)',
    MATURITY_MIN_CYCLES: process.env.MATURITY_MIN_CYCLES ?? '(default 3)',
    MATURITY_MIN_AGE_MINUTES: process.env.MATURITY_MIN_AGE_MINUTES ?? '(default 10)',
    PROMOTE_MIN_CONFIDENCE: process.env.PROMOTE_MIN_CONFIDENCE ?? '(default 55)',
    PROMOTE_MIN_FINAL_SCORE: process.env.PROMOTE_MIN_FINAL_SCORE ?? '(default 60)',
    PROMOTE_MIN_MATURITY: process.env.PROMOTE_MIN_MATURITY ?? '(default 70)',
    PROMOTE_MIN_RR: process.env.PROMOTE_MIN_RR ?? '(default 1.5)',
    SIGNAL_ENGINE_ALLOW_HIGH_VOL_REGIME:
      process.env.SIGNAL_ENGINE_ALLOW_HIGH_VOL_REGIME ?? '(unset; code default allow=true)',
    SIGNAL_ENGINE_ALLOW_HIGH_VOL:
      process.env.SIGNAL_ENGINE_ALLOW_HIGH_VOL ?? '(unset; UNUSED typo key)',
    SIGNAL_ENGINE_HIGH_VOL_PENALTY: process.env.SIGNAL_ENGINE_HIGH_VOL_PENALTY ?? '(default 12)',
    SIGNAL_RELAX_MODE: process.env.SIGNAL_RELAX_MODE ?? '(unset)',
  };
  console.log('\n[THRESHOLDS / ENV]');
  console.log(JSON.stringify(thresholdReport, null, 2));

  const { rows: stageCounts } = await db.query<{ stage: string; c: number }>(
    `SELECT stage, COUNT(*) AS c FROM q365_signal_maturity_tracker GROUP BY stage ORDER BY c DESC`,
  );
  console.log('\n[TRACKER STAGES]');
  console.log(JSON.stringify(stageCounts, null, 2));

  const { rows: snapCounts } = await db.query<{ status: string; c: number; max_c: string | null }>(
    `SELECT status, COUNT(*) AS c, MAX(confirmed_at) AS max_c
       FROM q365_confirmed_signal_snapshots
      GROUP BY status`,
  ).catch(() => ({ rows: [] as any[] }));
  console.log('\n[CONFIRMED SNAPSHOTS]');
  console.log(JSON.stringify(snapCounts, null, 2));

  const { rows: confStats } = await db.query<{
    n: number;
    avg_c: number | null;
    min_c: number | null;
    max_c: number | null;
    avg_comp: number | null;
    avg_final: number | null;
  }>(
    `SELECT COUNT(*) AS n,
            AVG(confidence_score) AS avg_c,
            MIN(confidence_score) AS min_c,
            MAX(confidence_score) AS max_c,
            AVG(composite_final_score) AS avg_comp,
            AVG(final_score) AS avg_final
       FROM q365_signals
      WHERE generated_at >= ?`,
    [SINCE],
  );
  console.log('\n[CONFIDENCE / SCORE STATS since ' + SINCE + ']');
  console.log(JSON.stringify(confStats[0] ?? {}, null, 2));

  const { rows: classHist } = await db.query<{
    classification: string | null;
    signal_status: string | null;
    c: number;
    avg_conf: number | null;
    avg_comp: number | null;
  }>(
    `SELECT classification, signal_status, COUNT(*) AS c,
            AVG(confidence_score) AS avg_conf,
            AVG(composite_final_score) AS avg_comp
       FROM q365_signals
      WHERE generated_at >= ?
      GROUP BY classification, signal_status
      ORDER BY c DESC
      LIMIT 30`,
    [SINCE],
  );
  console.log('\n[CLASSIFICATION × SIGNAL_STATUS since ' + SINCE + ']');
  console.log(JSON.stringify(classHist, null, 2));

  const { rows: matureTrackers } = await db.query<TrackerRow>(
    `SELECT id, symbol, direction, stage, maturity_score,
            validation_cycles_passed, stable, conviction_level,
            first_detected_at, last_seen_at, stability_history_json
       FROM q365_signal_maturity_tracker
      WHERE stage = 'mature'
        AND first_detected_at >= ?
      ORDER BY maturity_score DESC, validation_cycles_passed DESC
      LIMIT 500`,
    [SINCE],
  );

  const { rows: matureAll } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signal_maturity_tracker WHERE stage = 'mature'`,
  );
  const { rows: matureSince } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signal_maturity_tracker
      WHERE stage = 'mature' AND first_detected_at >= ?`,
    [SINCE],
  );

  console.log('\n[MATURE REACH]');
  console.log(JSON.stringify({
    mature_all_time_or_current: Number(matureAll[0]?.c ?? 0),
    mature_first_detected_since: Number(matureSince[0]?.c ?? 0),
  }, null, 2));

  const rejectHist: Record<string, number> = {};
  const decisions: DecisionRow[] = [];
  let promotedWould = 0;
  let noSignalRow = 0;
  const confList: number[] = [];

  for (const t of matureTrackers) {
    const { rows: sigs } = await db.query<SignalRow>(
      `SELECT id, symbol, direction, generated_at,
              confidence_score, final_score, composite_final_score,
              classification, signal_status, status, market_regime, market_stance,
              decay_state, factor_scores_json, phase4_factor_scores_json,
              scenario_tag, entry_price, stop_loss, target1, target2,
              risk_reward, pct_change, live_valid, rejection_codes_json
         FROM q365_signals
        WHERE symbol = ?
          AND direction = ?
          AND status IN ('active','watchlist','flagged')
          AND (invalidation_reason IS NULL
               OR invalidation_reason NOT IN (
                 'stop_loss_broken','stop_loss_broken_confirmed',
                 'target_reached','target_already_reached',
                 'engine_disagree','live_rejected'
               ))
          AND (expires_at IS NULL OR expires_at > NOW())
          AND decay_state <> 'expired'
        ORDER BY generated_at DESC
        LIMIT 1`,
      [t.symbol, t.direction],
    );
    const current = sigs[0];
    if (!current) {
      noSignalRow++;
      rejectHist['no_active_signal_row'] = (rejectHist['no_active_signal_row'] ?? 0) + 1;
      continue;
    }

    const factorObj = parseObj(current.factor_scores_json);
    const phase4Obj = parseObj(current.phase4_factor_scores_json as unknown);
    const flatFromStored = flattenNumericScores(factorObj);
    const flatFromPhase4 = flattenNumericScores(phase4Obj);

    const history = (() => {
      try {
        const raw = t.stability_history_json;
        if (!raw) return [];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

    const result = scoreMaturity({
      symbol: t.symbol,
      direction: t.direction,
      current: {
        entry_price: num(current.entry_price),
        stop_loss: num(current.stop_loss),
        target1: num(current.target1),
        confidence: num(current.confidence_score),
        final_score: numOrNull(current.final_score),
        decay_state: current.decay_state,
        classification: current.classification,
        factor_scores: (factorObj as any) ?? null,
        market_regime: current.market_regime,
        pct_change: numOrNull(current.pct_change),
        news_shock: null,
      },
      tracker: {
        first_detected_at: toMs(t.first_detected_at),
        last_seen_at: toMs(t.last_seen_at),
        cycles: Number(t.validation_cycles_passed),
        history: history as any,
      },
    });

    const topLevelNums = factorObj
      ? Object.values(factorObj).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      : [];
    const topAligned = topLevelNums.filter((v) => v >= 60).length;
    const multiAsProd =
      !factorObj ? 0.4
        : topLevelNums.length === 0 ? 0.4
          : Math.min(1, topAligned / 4);
    const phase4Aligned = flatFromPhase4.filter((x) => x.value >= 60).length;

    const rules = promotionRulesForStrategy(current.scenario_tag);
    const promotable = isPromotable(result, Number(t.validation_cycles_passed), rules);
    const rawCls = String(current.classification ?? '').toUpperCase();
    const promotionCls = resolvePromotionClassification(current);
    confList.push(num(current.confidence_score));

    let vetoReason = 'none';
    let decision = 'WOULD_PROMOTE';

    if (!promotable) {
      const hardBits = [
        result.stage !== 'mature' ? `stage=${result.stage}` : null,
        result.score < rules.minScore ? `score=${result.score}<${rules.minScore}` : null,
        Number(t.validation_cycles_passed) < rules.minCycles
          ? `cycles=${t.validation_cycles_passed}<${rules.minCycles}` : null,
        result.signalAgeMinutes < rules.minAgeMin
          ? `age=${result.signalAgeMinutes}<${rules.minAgeMin}` : null,
      ].filter(Boolean);
      vetoReason = hardBits.length
        ? `isPromotable(${hardBits.join(',')}); soft=${result.reasons[0] ?? 'none'}`
        : (result.reasons[0] ?? 'isPromotable_false');
      decision = 'REJECT_NOT_PROMOTABLE';
    } else if (!passesRegimeGate(result)) {
      vetoReason = 'REGIME_VETO';
      decision = 'REJECT_REGIME';
    } else if (!MAIN_TABLE_CLASSIFICATIONS.has(promotionCls)) {
      const ss = String(current.signal_status ?? '').toUpperCase();
      const comp = numOrNull(current.composite_final_score);
      if (ss === 'NO_TRADE') {
        vetoReason = `CLASSIFICATION_VETO(signal_status=NO_TRADE blocks upgrade; class=${rawCls}; composite=${comp})`;
      } else if (comp == null) {
        vetoReason = `CLASSIFICATION_VETO(class=${rawCls}; composite=null; no upgrade)`;
      } else if (comp < 50) {
        vetoReason = `CLASSIFICATION_VETO(class=${rawCls}; composite=${comp}<50; no upgrade)`;
      } else {
        vetoReason = `CLASSIFICATION_VETO(class=${rawCls}; promotion=${promotionCls})`;
      }
      decision = 'REJECT_CLASSIFICATION';
    } else {
      const writerFail = simulateWriterGate(
        current,
        promotionCls,
        Number(t.validation_cycles_passed),
        result.score,
      );
      if (writerFail) {
        vetoReason = writerFail;
        decision = 'REJECT_WRITER';
      } else {
        promotedWould++;
        decision = 'WOULD_PROMOTE';
        vetoReason = 'none';
      }
    }

    rejectHist[decision] = (rejectHist[decision] ?? 0) + 1;
    rejectHist[`detail:${vetoReason.split('(')[0]}`] =
      (rejectHist[`detail:${vetoReason.split('(')[0]}`] ?? 0) + 1;

    if (multiAsProd < 0.4) {
      rejectHist['confluence_raw_lt_0.4'] = (rejectHist['confluence_raw_lt_0.4'] ?? 0) + 1;
    }
    if (topLevelNums.length === 0 && flatFromStored.length > 0) {
      rejectHist['factor_scores_nested_not_flat'] = (rejectHist['factor_scores_nested_not_flat'] ?? 0) + 1;
    }
    if (phase4Aligned >= 2 && topAligned === 0) {
      rejectHist['phase4_would_pass_but_breakdown_fails'] =
        (rejectHist['phase4_would_pass_but_breakdown_fails'] ?? 0) + 1;
    }

    decisions.push({
      signalId: current.id,
      symbol: t.symbol,
      direction: t.direction,
      generatedAt: current.generated_at
        ? new Date(toMs(current.generated_at)).toISOString()
        : null,
      ageMin: result.signalAgeMinutes,
      trackerStage: t.stage,
      cycles: Number(t.validation_cycles_passed),
      rawConfidence: num(current.confidence_score),
      composite: numOrNull(current.composite_final_score),
      finalScore: numOrNull(current.final_score),
      factorsPassing60: topAligned,
      flatNumericCount: topLevelNums.length,
      multiFactorRaw: Math.round(multiAsProd * 100) / 100,
      classification: rawCls,
      signalStatus: String(current.signal_status ?? '').toUpperCase(),
      promotionCls,
      regime: String(current.market_regime ?? ''),
      maturityScore: result.score,
      vetoReason,
      decision,
      confluenceValuesSample: topLevelNums.slice(0, 6).map((v) => v.toFixed(1)).join(',')
        || (flatFromStored.length
          ? `nested:${flatFromStored.slice(0, 4).map((x) => `${x.key}=${x.value.toFixed(1)}`).join(';')}`
          : 'empty'),
    });
  }

  const sample = decisions.slice(0, SAMPLE_LIMIT);
  console.log(`\n[SAMPLE MATURE CANDIDATES] showing ${sample.length} of ${decisions.length}`);
  console.table(sample.map((d) => ({
    id: d.signalId,
    symbol: `${d.symbol}/${d.direction}`,
    generated: d.generatedAt?.slice(0, 16) ?? '',
    age_m: d.ageMin,
    cycles: d.cycles,
    conf: d.rawConfidence,
    composite: d.composite,
    mat: d.maturityScore,
    mf: d.multiFactorRaw,
    pass60: d.factorsPassing60,
    class: d.classification,
    sig_status: d.signalStatus,
    promo: d.promotionCls,
    regime: d.regime.slice(0, 22),
    decision: d.decision,
    veto: d.vetoReason.slice(0, 70),
  })));

  const avgConf = confList.length
    ? confList.reduce((a, b) => a + b, 0) / confList.length
    : null;
  const minConf = confList.length ? Math.min(...confList) : null;
  const maxConf = confList.length ? Math.max(...confList) : null;

  const { rows: qualifyProbe } = await db.query<{
    id: number;
    symbol: string;
    status: string;
    confidence_score: number;
    composite_final_score: number | null;
    classification: string;
    signal_status: string;
    risk_reward: number | null;
  }>(
    `SELECT id, symbol, status, confidence_score, composite_final_score,
            classification, signal_status, risk_reward
       FROM q365_signals
      WHERE UPPER(COALESCE(classification,'')) IN (
          'VALID_SIGNAL','HIGH_CONVICTION','INSTITUTIONAL_HIGH_CONVICTION',
          'HIGH_CONVICTION_BUY','VALID_BUY'
        )
        AND UPPER(COALESCE(signal_status,'')) = 'APPROVED_SIGNAL'
        AND confidence_score >= COALESCE(?, 55)
        AND COALESCE(composite_final_score, final_score, 0) >= COALESCE(?, 60)
        AND COALESCE(risk_reward, 0) >= COALESCE(?, 1.5)
      ORDER BY confidence_score DESC
      LIMIT 20`,
    [
      Number(process.env.PROMOTE_MIN_CONFIDENCE || 55),
      Number(process.env.PROMOTE_MIN_FINAL_SCORE || 60),
      Number(process.env.PROMOTE_MIN_RR || 1.5),
    ],
  );

  const { rows: hcAny } = await db.query<{
    id: number; symbol: string; status: string; confidence_score: number;
    composite_final_score: number | null; risk_reward: number | null; generated_at: string;
  }>(
    `SELECT id, symbol, status, confidence_score, composite_final_score, risk_reward, generated_at
       FROM q365_signals
      WHERE UPPER(COALESCE(classification,'')) = 'HIGH_CONVICTION'
      ORDER BY generated_at DESC LIMIT 10`,
  );

  const { rows: developingWithComposite } = await db.query<{
    c: number; avg_comp: number | null; avg_conf: number | null;
  }>(
    `SELECT COUNT(*) AS c,
            AVG(composite_final_score) AS avg_comp,
            AVG(confidence_score) AS avg_conf
       FROM q365_signals
      WHERE generated_at >= ?
        AND UPPER(COALESCE(classification,'')) = 'DEVELOPING_SETUP'
        AND UPPER(COALESCE(signal_status,'')) = 'NO_TRADE'
        AND composite_final_score >= 50`,
    [SINCE],
  );

  console.log('\n[REJECTION AGGREGATE — mature trackers since ' + SINCE + ']');
  console.log(JSON.stringify(rejectHist, null, 2));

  console.log('\n[FUNNEL SUMMARY]');
  console.log(JSON.stringify({
    mature_candidates_evaluated: decisions.length + noSignalRow,
    with_signal_row: decisions.length,
    no_active_signal_row: noSignalRow,
    would_promote: promotedWould,
    rejected_classification: rejectHist['REJECT_CLASSIFICATION'] ?? 0,
    rejected_not_promotable: rejectHist['REJECT_NOT_PROMOTABLE'] ?? 0,
    rejected_regime: rejectHist['REJECT_REGIME'] ?? 0,
    rejected_writer: rejectHist['REJECT_WRITER'] ?? 0,
    confluence_raw_lt_0_4: rejectHist['confluence_raw_lt_0.4'] ?? 0,
    nested_factor_scores: rejectHist['factor_scores_nested_not_flat'] ?? 0,
    phase4_mismatch: rejectHist['phase4_would_pass_but_breakdown_fails'] ?? 0,
    avg_confidence: avgConf != null ? Math.round(avgConf * 10) / 10 : null,
    min_confidence: minConf,
    max_confidence: maxConf,
  }, null, 2));

  console.log('\n[MATH QUALIFY — VALID/HIGH + APPROVED_SIGNAL clearing writer floors (any status)]');
  console.log(JSON.stringify({ count: qualifyProbe.length, sample: qualifyProbe.slice(0, 10) }, null, 2));

  console.log('\n[HIGH_CONVICTION rows — any status]');
  console.log(JSON.stringify(hcAny, null, 2));

  console.log('\n[DEVELOPING + NO_TRADE but composite>=50 — blocked by NO_TRADE upgrade ban]');
  console.log(JSON.stringify(developingWithComposite[0] ?? {}, null, 2));

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  VERDICT HINT');
  if (promotedWould > 0) {
    console.log(`  ${promotedWould} mature rows WOULD promote — check DQ gate / worker runtime.`);
  } else if ((rejectHist['REJECT_CLASSIFICATION'] ?? 0) >= decisions.length * 0.5) {
    console.log('  Dominant: CLASSIFICATION_VETO (NO_TRADE freezes DEVELOPING_SETUP; no composite upgrade).');
  } else if ((rejectHist['REJECT_WRITER'] ?? 0) > 0) {
    console.log('  Clear maturity/class but fail writer floors (confidence/final/rr/edge/maturity).');
  } else {
    console.log('  See rejection aggregate for dominant gate.');
  }
  console.log('════════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch((err) => {
  console.error('[diagnostics:maturity] FAILED', err?.message ?? err);
  process.exit(1);
});
