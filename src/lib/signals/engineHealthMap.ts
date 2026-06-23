// ════════════════════════════════════════════════════════════════
//  engineHealthMap — PHASE_5_HEALTH_OBSERVABILITY_2026-05
//
//  Builds a structured health-and-dependency map for every engine
//  in the signal pipeline:
//
//    Data Feed → Market Status → Scanner → Indicators → Scoring →
//    Risk → Confirmation → Due Diligence → Daily Report →
//    Backtesting → Learning
//
//  CRITICAL SAFETY RULES:
//   - This module NEVER fabricates engine health. Every node is
//     evaluated against real signals/counters/timestamps the caller
//     hands in.
//   - Missing data → status NOT_CONFIGURED or INSUFFICIENT_DATA with
//     an explicit warning string. Nothing is marked HEALTHY without
//     evidence.
//   - This module reads inputs only. It NEVER alters approval logic,
//     thresholds, or scoring weights.
//
//  Pure module — no I/O, no DB, no env reads. Same input → same
//  output. Caller (the route layer) gathers real data.
// ════════════════════════════════════════════════════════════════

import type { RankableSignal } from '@/lib/signals/signalRanking';
import type { DueDiligenceSummary } from '@/lib/signals/signalDueDiligence';
import {
  classifyCandleFreshness,
} from '@/lib/marketData/candleFreshness';

// ── Public contract ─────────────────────────────────────────────

export type EngineStatus =
  | 'HEALTHY'
  | 'WARNING'
  | 'DEGRADED'
  | 'BROKEN'
  | 'STALE'
  | 'NOT_CONFIGURED'
  | 'INSUFFICIENT_DATA'
  | 'UNKNOWN';

export type EngineSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type EngineCategory =
  | 'DATA' | 'MARKET' | 'SCANNER' | 'INDICATOR' | 'SCORING' | 'RISK'
  | 'CONFIRMATION' | 'DUE_DILIGENCE' | 'REPORTING' | 'BACKTESTING' | 'LEARNING';

export interface EngineHealthLink {
  label: string;
  href:  string;
}

export interface EngineDiagnostics {
  primaryIssue:        string | null;
  findings:            string[];
  warnings:            string[];
  errors:              string[];
  recommendedActions:  string[];
}

export interface EngineHealthNode {
  id:                  string;
  name:                string;
  category:            EngineCategory;
  status:              EngineStatus;
  severity:            EngineSeverity;
  description:         string;
  lastRunAt:           string | null;
  lastSuccessAt:       string | null;
  lastFailureAt:       string | null;
  freshnessMinutes:    number | null;
  inputCount:          number | null;
  outputCount:         number | null;
  errorCount:          number;
  warningCount:        number;
  dependencies:        string[];
  blockedBy:           string[];
  downstreamImpact:    string[];
  diagnostics:         EngineDiagnostics;
  metrics:             Record<string, number | string | boolean | null>;
  links:               EngineHealthLink[];
}

export interface EngineHealthEdge {
  from:        string;
  to:          string;
  status:      'OK' | 'WARNING' | 'BROKEN';
  explanation: string;
}

export interface PipelineReadiness {
  canGenerateApprovedSignals: boolean;
  canGenerateCandidates:      boolean;
  canRunDueDiligence:         boolean;
  canRunDailyReport:          boolean;
  canRunBacktest:             boolean;
  blockingReasons:            string[];
}

export interface EngineHealthMap {
  generatedAt:                  string;
  overallStatus:                'HEALTHY' | 'WARNING' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';
  overallSummary:               string;
  criticalIssues:               string[];
  warningIssues:                string[];
  healthyCount:                 number;
  warningCount:                 number;
  degradedCount:                number;
  brokenCount:                  number;
  staleCount:                   number;
  notConfiguredCount:           number;
  nodes:                        EngineHealthNode[];
  edges:                        EngineHealthEdge[];
  pipelineReadiness:            PipelineReadiness;
  signalReadinessExplanation:   string;
}

/** Lightweight preview shape — used by /api/signals so the dashboard
 *  can render a tiny chip without an extra round trip. */
export interface EngineHealthPreview {
  overallStatus:               EngineHealthMap['overallStatus'];
  canGenerateApprovedSignals:  boolean;
  canGenerateCandidates:       boolean;
  primaryBlockingReason:       string | null;
  engineHealthUrl:             string;
}

// ── Builder input ──────────────────────────────────────────────

export interface EngineHealthContext {
  generatedAt?: string;

  marketStatus: {
    isOpen:  boolean;
    label:   string;
    state?:  string | null;
  };

  /** Provider + freshness state copied from the /api/signals payload.
   *  When the /api/signals envelope is unavailable, the route layer
   *  fills these from a direct DB probe so the Data Feed Engine card
   *  doesn't false-fail with "No provider activity recorded." */
  feed: {
    provider:           string | null;
    lastSuccessAt:      string | null;
    lastApiRequestAt:   string | null;
    isBootstrap:        boolean;
    isFallback:         boolean;
    staleMinutes:       number | null;
    freshnessLabel:     string | null;
    coveragePercent:    number | null;
    symbolsRequested:   number | null;
    symbolsReturned:    number | null;
    candleAgeHours:     number | null;
    /** Direct DB fallback — populated when the route layer queries
     *  the `candles` warehouse independently of the signals envelope. */
    candleCoverage?: {
      latestCandleDate:  string | null;
      candleCount:       number;
      distinctSymbols:   number;
    };
  };

  /** Transport-level health of the routes the aggregator called.
   *  Lets the builder mark a node DEGRADED ("signal envelope delayed")
   *  vs NOT_CONFIGURED ("provider never wired"). */
  transport?: {
    signalsAvailable:     boolean;
    signalsTimedOut?:     boolean;
    signalsErrorMessage?: string | null;
    dailyReportAvailable: boolean;
    backtestAvailable:    boolean;
  };

  /** Pipeline run info. */
  pipeline: {
    lastPipelineRunAt:        string | null;
    lastConfirmedSignalAt:    string | null;
    latestBatchId:            string | null;
    latestBatchEngineKind:    string | null;
    scanCoveragePercent:      number | null;
    totalScanned:             number | null;
    totalPersisted:           number | null;
    universeSize:             number | null;
    inProgressCount:          number | null;
    validationStatus:         string | null;
  };

  /** Already-filtered signal pools from the /api/signals envelope. */
  signals: {
    approved:           RankableSignal[];
    highPotential:      RankableSignal[];
    watchlist:          RankableSignal[];
    developing:         RankableSignal[];
    scannerCandidates:  RankableSignal[];
    riskRestricted:     RankableSignal[];
    rejected:           RankableSignal[];
  };

  /** Counters block from the /api/signals envelope. */
  counters: {
    approvedTotal:       number;
    approvedBuy:         number;
    approvedSell:        number;
    highPotentialTotal:  number;
    watchlistTotal:      number;
    rejectedTotal:       number;
    candidateTotal:      number;
  };

  dueDiligenceSummary: DueDiligenceSummary | null;

  /** Optional already-computed reports/backtests. Builder DOES NOT
   *  call APIs — the route layer fetches and passes results. */
  dailyReport?: {
    available:     boolean;
    reportStatus?: 'COMPLETE' | 'PARTIAL' | 'PENDING' | 'INSUFFICIENT_DATA';
    generatedAt?:  string | null;
    warnings?:     string[];
  };
  backtest?: {
    available:        boolean;
    status?:          'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'FAILED';
    window?:          string;
    generatedAt?:     string | null;
    symbolsWithData?: number;
    totalSymbols?:    number;
    warnings?:        string[];
  };
}

// ── Internals ───────────────────────────────────────────────────

const minutesSince = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
};

const severityFromStatus = (s: EngineStatus): EngineSeverity => {
  switch (s) {
    case 'HEALTHY':           return 'LOW';
    case 'WARNING':           return 'MEDIUM';
    case 'DEGRADED':          return 'HIGH';
    case 'BROKEN':            return 'CRITICAL';
    case 'STALE':             return 'HIGH';
    case 'NOT_CONFIGURED':    return 'MEDIUM';
    case 'INSUFFICIENT_DATA': return 'MEDIUM';
    case 'UNKNOWN':           return 'MEDIUM';
  }
};

const emptyDiagnostics = (): EngineDiagnostics => ({
  primaryIssue:       null,
  findings:           [],
  warnings:           [],
  errors:             [],
  recommendedActions: [],
});

/** Count how many rows in `pool` have a populated numeric field. */
const populated = (pool: readonly RankableSignal[], key: keyof RankableSignal): number => {
  let n = 0;
  for (const r of pool) {
    const v = (r as any)[key];
    if (typeof v === 'number' && Number.isFinite(v)) n++;
    else if (typeof v === 'string' && v.trim() !== '') n++;
  }
  return n;
};

/** Resolve feed staleness using daily-tolerant bands for EOD candles. */
function feedStalenessFromContext(
  staleMinutes: number | null,
  candleAgeHours: number | null,
  marketOpen: boolean,
): Pick<LightweightHealthPreviewInput, 'staleMinutes' | 'freshnessMode' | 'feedFrozen' | 'freshnessQuality'> {
  const ageMs = candleAgeHours != null
    ? candleAgeHours * 3_600_000
    : staleMinutes != null
      ? staleMinutes * 60_000
      : null;
  const report = classifyCandleFreshness({
    latest_candle_ms: ageMs != null ? Date.now() - ageMs : null,
    market_open:      marketOpen,
    candle_source:    'daily',
  });
  return {
    staleMinutes: staleMinutes ?? (candleAgeHours != null ? Math.round(candleAgeHours * 60) : null),
    freshnessMode:    report.freshness_mode,
    feedFrozen:       report.feed_frozen,
    freshnessQuality: report.freshness_quality,
  };
}

function feedStalenessBands(
  staleMinutes: number | null,
  candleAgeHours: number | null,
  marketOpen: boolean,
): ReturnType<typeof resolveFeedStaleness> {
  const bands = feedStalenessFromContext(staleMinutes, candleAgeHours, marketOpen);
  return resolveFeedStaleness({
    marketOpen,
    isBootstrap: false,
    isFallback:  false,
    staleMinutes: bands.staleMinutes,
    freshnessMode: bands.freshnessMode,
    feedFrozen: bands.feedFrozen,
    freshnessQuality: bands.freshnessQuality,
    approvedTotal:  0,
    candidateTotal: 0,
  });
}

/** Daily EOD pipelines run once per session — 3h intraday cadence is too tight. */
function scannerStaleThresholdMinutes(marketOpen: boolean): number {
  return marketOpen ? 36 * 60 : 72 * 60;
}

function hasScannerRunEvidence(
  p: EngineHealthContext['pipeline'],
  candidatesProduced: number,
  candidateTotal: number,
): boolean {
  return (p.totalScanned ?? 0) > 0
    || (p.totalPersisted ?? 0) > 0
    || candidatesProduced > 0
    || candidateTotal > 0
    || (p.latestBatchId != null && p.latestBatchId !== '');
}

/** True when the last scanner run is from a prior session but output is
 *  still being served — common across weekends / before today's cycle. */
function isExpectedScannerSessionGap(
  minsSinceRun: number | null,
  hasEvidence: boolean,
): boolean {
  if (minsSinceRun == null || !hasEvidence) return false;
  return minsSinceRun <= MAX_EXPECTED_DAILY_GAP_MINUTES;
}

// ── Node builders ──────────────────────────────────────────────

export function buildDataFeedHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const stale = ctx.feed.staleMinutes;

  // Candle-warehouse fallback — if the signals envelope was unavailable
  // but the candle warehouse has rows, the data feed is functional but
  // delayed, not "not configured".
  const cov = ctx.feed.candleCoverage ?? null;
  const candleCount      = cov?.candleCount      ?? 0;
  const distinctSymbols  = cov?.distinctSymbols  ?? 0;
  const latestCandleDate = cov?.latestCandleDate ?? null;
  const candleAgeMs = latestCandleDate
    ? Math.max(0, Date.now() - new Date(`${latestCandleDate}T00:00:00Z`).getTime())
    : null;
  const candleAgeHours = candleAgeMs != null ? Math.round(candleAgeMs / 3_600_000) : null;

  const signalsTimedOut    = ctx.transport?.signalsTimedOut === true;
  const signalsUnavailable = ctx.transport?.signalsAvailable === false;

  let status: EngineStatus = 'UNKNOWN';
  if (ctx.feed.provider == null && ctx.feed.lastSuccessAt == null) {
    // Differentiate "envelope delayed but warehouse healthy" from
    // "nothing ever ran". Warehouse rows mean the data feed is
    // operational; the read path just hasn't surfaced yet.
    if (candleCount > 0 && candleAgeHours != null && candleAgeHours <= 36) {
      status = 'HEALTHY';
      diag.findings.push(`Candle warehouse healthy — ${candleCount} rows across ${distinctSymbols} symbols, latest ${latestCandleDate}.`);
      if (signalsUnavailable) {
        diag.findings.push(signalsTimedOut
          ? 'Signal envelope delayed — using direct candle warehouse readings.'
          : 'Signal envelope unavailable — using direct candle warehouse readings.');
      }
    } else if (candleCount > 0) {
      const bands = feedStalenessFromContext(
        stale,
        ctx.feed.candleAgeHours ?? candleAgeHours,
        ctx.marketStatus.isOpen,
      );
      const expectedGap = isExpectedDailySessionGap({
        freshnessMode:    bands.freshnessMode,
        staleMinutes:     bands.staleMinutes
          ?? (candleAgeHours != null ? Math.round(candleAgeHours * 60) : null),
        feedFrozen:       bands.feedFrozen,
        freshnessQuality: bands.freshnessQuality,
        feedStaleHigh:    bands.feedFrozen || (bands.staleMinutes != null && bands.staleMinutes > 72 * 60),
      });
      if (expectedGap) {
        status = 'HEALTHY';
        diag.findings.push(`Candle warehouse available — latest ${latestCandleDate ?? 'unknown'}.`);
      } else {
        status = 'STALE';
        diag.primaryIssue = `Candle warehouse is ${candleAgeHours ?? '?'}h stale (latest ${latestCandleDate ?? 'unknown'}).`;
        diag.warnings.push('No fresh EOD ingestion within the freshness window.');
        diag.recommendedActions.push('Run EOD ingestion (POST /api/manipulation/eod-ingest).');
      }
    } else {
      status = 'NOT_CONFIGURED';
      diag.primaryIssue = 'No provider activity and no candle warehouse rows.';
      diag.warnings.push('Provider health data unavailable.');
      diag.recommendedActions.push('Run market data refresh');
    }
  } else if (ctx.feed.isBootstrap) {
    status = 'WARNING';
    diag.primaryIssue = 'Operating on bootstrap-seeded data.';
    diag.warnings.push('Bootstrap mode — not a live broker feed.');
    diag.recommendedActions.push('Restore live IndianAPI tick before relying on outcomes.');
  } else if (ctx.feed.isFallback) {
    status = 'DEGRADED';
    diag.primaryIssue = 'Provider running on fallback path.';
    diag.warnings.push('Fallback mode active — data quality degraded.');
    diag.recommendedActions.push('Investigate primary provider failures (rate-limit / network).');
  } else if (!ctx.marketStatus.isOpen) {
    status = 'HEALTHY';
    diag.findings.push('Market closed — serving last-close / snapshot data.');
  } else {
    const { staleHigh, staleMid, reason } = feedStalenessBands(
      stale,
      ctx.feed.candleAgeHours,
      ctx.marketStatus.isOpen,
    );
    if (staleHigh) {
      const bands = feedStalenessFromContext(
        stale,
        ctx.feed.candleAgeHours,
        ctx.marketStatus.isOpen,
      );
      const expectedDailyGap = isExpectedDailySessionGap({
        freshnessMode:    bands.freshnessMode,
        staleMinutes:     bands.staleMinutes,
        feedFrozen:       bands.feedFrozen,
        freshnessQuality: bands.freshnessQuality,
        feedStaleHigh:    true,
      });
      if (expectedDailyGap) {
        status = 'HEALTHY';
        diag.findings.push(
          reason
            ?? (ctx.marketStatus.isOpen
              ? 'Awaiting today\'s EOD candle — last session bar in use.'
              : 'Last session EOD bar in use.'),
        );
      } else {
        status = 'STALE';
        diag.primaryIssue = reason ?? 'Provider feed exceeded daily freshness window.';
        diag.warnings.push('Feed exceeded institutional approval-freeze threshold.');
        diag.recommendedActions.push('Trigger a manual pipeline run; check provider connectivity.');
      }
    } else if (staleMid) {
      const bands = feedStalenessFromContext(
        stale,
        ctx.feed.candleAgeHours,
        ctx.marketStatus.isOpen,
      );
      const expectedMidGap = bands.freshnessMode === 'daily_tolerant'
        || isExpectedDailySessionGap({
          freshnessMode:    bands.freshnessMode,
          staleMinutes:     bands.staleMinutes,
          feedFrozen:       bands.feedFrozen,
          freshnessQuality: bands.freshnessQuality,
        });
      if (expectedMidGap) {
        status = 'HEALTHY';
        diag.findings.push(reason ?? 'Daily feed within expected session cadence.');
      } else {
        status = 'WARNING';
        diag.primaryIssue = reason ?? `Provider feed aging (${stale ?? '?'}m).`;
        diag.warnings.push('Approvals may be demoted while feed ages.');
      }
    } else {
      status = 'HEALTHY';
    }
  }
  if (
    typeof ctx.feed.coveragePercent === 'number'
    && ctx.feed.coveragePercent < 50
    && status === 'HEALTHY'
    && ctx.marketStatus.isOpen
    && !ctx.feed.isFallback
  ) {
    // Provider batch coverage from IndianAPI resolver — not scanner
    // persistence %. Informational only; daily EOD feeds often run
    // partial batches without implying the feed is broken.
    diag.findings.push(`Provider batch coverage ${ctx.feed.coveragePercent}% (target ≥ 50%).`);
  }
  return {
    id:                'data_feed',
    name:              'Data Feed Engine',
    category:          'DATA',
    status,
    severity:          severityFromStatus(status),
    description:       'IndianAPI / Yahoo / Kite provider pipeline that feeds market data into the engine.',
    lastRunAt:         ctx.feed.lastApiRequestAt,
    lastSuccessAt:     ctx.feed.lastSuccessAt,
    lastFailureAt:     null,
    freshnessMinutes:  stale,
    inputCount:        ctx.feed.symbolsRequested,
    outputCount:       ctx.feed.symbolsReturned,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      [],
    blockedBy:         [],
    downstreamImpact:  ['market_status', 'scanner', 'indicators', 'scoring', 'risk', 'confirmation'],
    diagnostics:       diag,
    metrics: {
      provider:          ctx.feed.provider,
      coveragePercent:   ctx.feed.coveragePercent,
      candleAgeHours:    ctx.feed.candleAgeHours,
      isBootstrap:       ctx.feed.isBootstrap,
      isFallback:        ctx.feed.isFallback,
      freshnessLabel:    ctx.feed.freshnessLabel,
    },
    links: [
      { label: 'Open Signal Engine',     href: '/signals' },
      { label: 'Open Backtesting Lab',   href: '/signals/backtesting' },
    ],
  };
}

export function buildMarketStatusHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  let status: EngineStatus;
  if (typeof ctx.marketStatus.isOpen !== 'boolean') {
    status = 'INSUFFICIENT_DATA';
    diag.primaryIssue = 'Market state unknown.';
    diag.warnings.push('Market status detector did not return an open/closed value.');
  } else {
    status = 'HEALTHY';
    diag.findings.push(`Market ${ctx.marketStatus.isOpen ? 'OPEN' : 'CLOSED'} (${ctx.marketStatus.label}).`);
  }
  return {
    id:                'market_status',
    name:              'Market Status Engine',
    category:          'MARKET',
    status,
    severity:          severityFromStatus(status),
    description:       'Detects NSE session state and applies live vs market-closed code paths.',
    lastRunAt:         ctx.generatedAt ?? new Date().toISOString(),
    lastSuccessAt:     ctx.generatedAt ?? new Date().toISOString(),
    lastFailureAt:     null,
    freshnessMinutes:  0,
    inputCount:        null,
    outputCount:       null,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['data_feed'],
    blockedBy:         [],
    downstreamImpact:  ['scanner', 'confirmation'],
    diagnostics:       diag,
    metrics: {
      isOpen: ctx.marketStatus.isOpen,
      label:  ctx.marketStatus.label,
      state:  ctx.marketStatus.state ?? null,
    },
    links: [{ label: 'Open Signal Engine', href: '/signals' }],
  };
}

export function buildScannerHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const p = ctx.pipeline;
  const minsSinceRun = minutesSince(p.lastPipelineRunAt);
  const candidatesProduced =
    ctx.signals.highPotential.length +
    ctx.signals.watchlist.length +
    ctx.signals.developing.length +
    ctx.signals.scannerCandidates.length;

  // Distinguish "signal envelope delayed → no pipeline read" from
  // "scanner never ran on this deployment". When the candle warehouse
  // has rows but the envelope was unavailable, the scanner status is
  // unknown rather than not-configured.
  const signalsUnavailable = ctx.transport?.signalsAvailable === false;
  const candleCount        = ctx.feed.candleCoverage?.candleCount ?? 0;
  const scanEvidence       = hasScannerRunEvidence(p, candidatesProduced, ctx.counters.candidateTotal);

  let status: EngineStatus = 'UNKNOWN';
  if (p.lastPipelineRunAt == null) {
    if (scanEvidence) {
      status = 'HEALTHY';
      diag.findings.push('Scanner output available from stored pipeline results.');
    } else if (signalsUnavailable && candleCount > 0) {
      status = 'HEALTHY';
      diag.findings.push('Signal envelope delayed — scanner status inferred from warehouse data.');
    } else {
      status = 'NOT_CONFIGURED';
      diag.primaryIssue = 'No pipeline run recorded.';
      diag.warnings.push('Scanner has not run since last process boot.');
      diag.recommendedActions.push('Run scanner pipeline');
    }
  } else if (!ctx.marketStatus.isOpen) {
    status = 'HEALTHY';
    diag.findings.push(
      scanEvidence
        ? `Market closed — last scanner run ${minsSinceRun ?? '?'}m ago; serving last-session candidates.`
        : 'Market closed — scanner idle until next session.',
    );
  } else if (
    minsSinceRun != null
    && minsSinceRun > scannerStaleThresholdMinutes(ctx.marketStatus.isOpen)
  ) {
    if (isExpectedScannerSessionGap(minsSinceRun, scanEvidence)) {
      status = 'HEALTHY';
      diag.findings.push(
        `Last scanner run ${minsSinceRun}m ago — awaiting today's session cycle.`,
      );
    } else if (scanEvidence) {
      status = 'WARNING';
      diag.primaryIssue = `Scanner has not run for ${minsSinceRun}m during market hours.`;
      diag.warnings.push('Scanner cadence behind expected interval.');
      diag.recommendedActions.push('Check scheduler health — see workers/scheduler.ts.');
    } else {
      status = 'STALE';
      diag.primaryIssue = `Scanner has not run for ${minsSinceRun}m during market hours.`;
      diag.warnings.push('Scanner cadence behind expected interval.');
      diag.recommendedActions.push('Check scheduler health — see workers/scheduler.ts.');
    }
  } else if (candidatesProduced === 0 && ctx.counters.candidateTotal === 0 && p.totalScanned != null && p.totalScanned > 0) {
    status = 'WARNING';
    diag.primaryIssue = 'Scanner ran but produced zero candidates.';
    diag.warnings.push(`${p.totalScanned} symbols scanned, 0 candidates surfaced.`);
    diag.findings.push('This can be normal in unfavourable regimes.');
  } else if (candidatesProduced === 0 && p.totalScanned == null) {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No scan-coverage metric available; cannot assess scanner output.');
  } else {
    status = 'HEALTHY';
    diag.findings.push(`Scanner produced ${candidatesProduced} candidates across tiers.`);
  }

  return {
    id:                'scanner',
    name:              'Scanner Engine',
    category:          'SCANNER',
    status,
    severity:          severityFromStatus(status),
    description:       'Walks the symbol universe and emits per-symbol scanner candidates.',
    lastRunAt:         p.lastPipelineRunAt,
    lastSuccessAt:     p.lastPipelineRunAt,
    lastFailureAt:     null,
    freshnessMinutes:  minsSinceRun,
    inputCount:        p.universeSize,
    outputCount:       candidatesProduced,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['data_feed', 'market_status'],
    blockedBy:         [],
    downstreamImpact:  ['indicators', 'scoring', 'confirmation'],
    diagnostics:       diag,
    metrics: {
      latestBatchId:       p.latestBatchId,
      latestBatchEngine:   p.latestBatchEngineKind,
      scanCoveragePercent: p.scanCoveragePercent,
      totalScanned:        p.totalScanned,
      totalPersisted:      p.totalPersisted,
    },
    links: [{ label: 'Open Signal Engine', href: '/signals' }],
  };
}

const FACTOR_KEYS = [
  'trend_alignment',
  'momentum',
  'volume_confirmation',
  'strategy_quality',
  'market_regime',
  'liquidity',
  'portfolio_fit',
];

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const FLAT_FACTOR_SCORE_KEYS = [
  'portfolio_fit_score',
  'liquidity_score',
  'market_regime_score',
  'data_quality_score',
  'stress_survival_score',
  'trend_alignment_score',
  'momentum_score',
  'volume_confirmation_score',
  'strategy_quality_score',
] as const;

/** True when a row carries Phase-4 / elite factor evidence.
 *  Lite API rows omit the factor_scores blob but still expose the
 *  flattened *_score columns and composite final/confidence scores. */
const hasAnyFactor = (s: any): boolean => {
  const fs = s?.factor_scores;
  if (fs && typeof fs === 'object') {
    for (const k of FACTOR_KEYS) {
      const v = (fs as any)[k];
      if (typeof v === 'number' && Number.isFinite(v)) return true;
    }
    for (const v of Object.values(fs)) {
      if (typeof v === 'number' && Number.isFinite(v)) return true;
    }
  }
  for (const k of FLAT_FACTOR_SCORE_KEYS) {
    if (numOrNull((s as any)[k]) != null) return true;
  }
  const final = numOrNull(s?.final_score ?? s?.institutional_score);
  const conf  = numOrNull(s?.confidence_score ?? s?.confidence);
  return final != null && conf != null;
};

const hasCompositeScore = (s: any): boolean =>
  numOrNull(s?.final_score ?? s?.institutional_score) != null;

export function buildIndicatorHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const allRows = [
    ...ctx.signals.approved, ...ctx.signals.highPotential,
    ...ctx.signals.watchlist, ...ctx.signals.developing,
    ...ctx.signals.scannerCandidates, ...ctx.signals.riskRestricted,
    ...ctx.signals.rejected,
  ];
  const total = allRows.length;
  const withFactors = allRows.filter(hasAnyFactor).length;
  const withFinal   = allRows.filter(hasCompositeScore).length;
  const covered     = allRows.filter((r) => hasAnyFactor(r) || hasCompositeScore(r)).length;
  const coverage = total > 0 ? Math.round((covered / total) * 100) : null;
  let status: EngineStatus;
  if (total === 0) {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No signals or candidates available to inspect indicator coverage.');
    diag.recommendedActions.push('Waiting for scanner candidates');
  } else if (coverage != null && coverage >= 80) {
    status = 'HEALTHY';
    diag.findings.push(
      `Factor/score fields populated on ${coverage}% of rows`
      + (withFactors < withFinal ? ' (via composite scores).' : '.'),
    );
  } else if (coverage != null && coverage >= 40) {
    status = 'WARNING';
    diag.primaryIssue = `Factor scores populated on only ${coverage}% of rows.`;
    diag.warnings.push('Indicator coverage below institutional target.');
  } else if (withFinal > 0) {
    // Composite scores present — scorer path ran; treat as operational.
    status = 'HEALTHY';
    diag.findings.push(
      `Composite scores present on ${withFinal}/${total} rows; factor blob may be omitted in lite responses.`,
    );
  } else {
    status = 'DEGRADED';
    diag.primaryIssue = `Factor scores populated on ${coverage ?? 0}% of rows.`;
    diag.errors.push('Indicator engine appears to be missing for most rows.');
    diag.recommendedActions.push('Confirm Phase-4 scorer wiring; check factor_scores column writes.');
  }
  return {
    id:                'indicators',
    name:              'Indicator Engine',
    category:          'INDICATOR',
    status,
    severity:          severityFromStatus(status),
    description:       'Computes trend / momentum / volume / regime / liquidity factor scores per row.',
    lastRunAt:         ctx.pipeline.lastPipelineRunAt,
    lastSuccessAt:     ctx.pipeline.lastPipelineRunAt,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(ctx.pipeline.lastPipelineRunAt),
    inputCount:        total,
    outputCount:       covered,
    errorCount:        status === 'DEGRADED' ? 1 : 0,
    warningCount:      diag.warnings.length,
    dependencies:      ['scanner', 'data_feed'],
    blockedBy:         [],
    downstreamImpact:  ['scoring', 'risk', 'due_diligence'],
    diagnostics:       diag,
    metrics: { coveragePercent: coverage },
    links: [{ label: 'Open Backtesting Lab', href: '/signals/backtesting' }],
  };
}

export function buildScoringHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const allRows = [
    ...ctx.signals.approved, ...ctx.signals.highPotential,
    ...ctx.signals.watchlist, ...ctx.signals.developing,
    ...ctx.signals.scannerCandidates, ...ctx.signals.rejected,
  ];
  const total = allRows.length;
  const withFinal      = populated(allRows, 'final_score' as keyof RankableSignal);
  const withConfidence = populated(allRows, 'confidence_score' as keyof RankableSignal);
  let status: EngineStatus;
  if (total === 0) {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No signal pool to evaluate scoring.');
    diag.recommendedActions.push('Waiting for indicator output');
  } else if (withFinal === total && withConfidence === total) {
    status = 'HEALTHY';
    diag.findings.push('Every reviewed row has final_score + confidence_score populated.');
  } else if (withFinal / total >= 0.8) {
    status = 'WARNING';
    diag.primaryIssue = `${withFinal}/${total} rows have final_score; ${withConfidence}/${total} have confidence.`;
  } else {
    status = 'DEGRADED';
    diag.primaryIssue = `final_score populated on ${withFinal}/${total} rows only.`;
    diag.recommendedActions.push('Inspect Phase-4 scorer output and DB write path.');
  }
  return {
    id:                'scoring',
    name:              'Signal Scoring Engine',
    category:          'SCORING',
    status,
    severity:          severityFromStatus(status),
    description:       'Aggregates indicator + risk factors into composite final_score / confidence_score.',
    lastRunAt:         ctx.pipeline.lastPipelineRunAt,
    lastSuccessAt:     ctx.pipeline.lastPipelineRunAt,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(ctx.pipeline.lastPipelineRunAt),
    inputCount:        total,
    outputCount:       withFinal,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['indicators'],
    blockedBy:         [],
    downstreamImpact:  ['risk', 'confirmation', 'due_diligence'],
    diagnostics:       diag,
    metrics: { rowsWithFinalScore: withFinal, rowsWithConfidence: withConfidence, totalRows: total },
    links: [{ label: 'Open Signal Engine', href: '/signals' }],
  };
}

export function buildRiskHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const allRows = [
    ...ctx.signals.approved, ...ctx.signals.highPotential,
    ...ctx.signals.watchlist, ...ctx.signals.developing,
    ...ctx.signals.scannerCandidates, ...ctx.signals.rejected,
  ];
  const total      = allRows.length;
  const rowRR = (r: any) => Number(r.risk_reward ?? r.rr_ratio ?? r.riskReward);
  const rowStop = (r: any) => Number(r.stop_loss ?? r.stopLoss);
  const rowTarget = (r: any) => Number(r.target1 ?? r.target ?? r.targets?.target1);
  const withRR     = allRows.filter((r) => Number.isFinite(rowRR(r))).length;
  const withStop   = allRows.filter((r) => Number.isFinite(rowStop(r))).length;
  const withTarget = allRows.filter((r) => Number.isFinite(rowTarget(r))).length;
  let status: EngineStatus;
  if (total === 0) {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No signal pool to evaluate risk fields.');
    diag.recommendedActions.push('Waiting for scored signals');
  } else if (withRR === total && withStop === total && withTarget === total) {
    status = 'HEALTHY';
  } else if (withRR / total >= 0.7 && withStop / total >= 0.7) {
    status = 'WARNING';
    diag.primaryIssue = 'Some rows missing target / stop / RR.';
  } else {
    status = 'DEGRADED';
    diag.primaryIssue = `Risk-geometry coverage low (RR ${withRR}/${total}, stop ${withStop}/${total}, target ${withTarget}/${total}).`;
    diag.recommendedActions.push('Inspect Phase-4 risk-engine output for missing stop/target geometry.');
  }
  return {
    id:                'risk',
    name:              'Risk Engine',
    category:          'RISK',
    status,
    severity:          severityFromStatus(status),
    description:       'Calculates RR / stop / target geometry and applies execution-allowed predicate.',
    lastRunAt:         ctx.pipeline.lastPipelineRunAt,
    lastSuccessAt:     ctx.pipeline.lastPipelineRunAt,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(ctx.pipeline.lastPipelineRunAt),
    inputCount:        total,
    outputCount:       Math.min(withRR, withStop, withTarget),
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['scoring'],
    blockedBy:         [],
    downstreamImpact:  ['confirmation'],
    diagnostics:       diag,
    metrics: { rowsWithRR: withRR, rowsWithStop: withStop, rowsWithTarget: withTarget, totalRows: total },
    links: [{ label: 'Open Signal Engine', href: '/signals' }],
  };
}

export function buildConfirmationHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const approvedTotal = ctx.counters.approvedTotal;
  const candidates    = ctx.counters.candidateTotal;
  let status: EngineStatus;
  if (approvedTotal === 0 && candidates === 0) {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No approved signals or candidates to evaluate confirmation engine.');
    diag.recommendedActions.push('Waiting for candidates from scanner');
  } else if (approvedTotal === 0 && candidates > 0 && !ctx.marketStatus.isOpen) {
    status = 'HEALTHY';
    diag.findings.push('Market closed — confirmation gate withholds new approvals by design.');
  } else if (approvedTotal === 0 && candidates > 0 && feedStalenessBands(
    ctx.feed.staleMinutes,
    ctx.feed.candleAgeHours,
    ctx.marketStatus.isOpen,
  ).staleHigh) {
    const bands = feedStalenessFromContext(
      ctx.feed.staleMinutes,
      ctx.feed.candleAgeHours,
      ctx.marketStatus.isOpen,
    );
    const expectedDailyGap = isExpectedDailySessionGap({
      freshnessMode:    bands.freshnessMode,
      staleMinutes:     bands.staleMinutes,
      feedFrozen:       bands.feedFrozen,
      freshnessQuality: bands.freshnessQuality,
      feedStaleHigh:    true,
    });
    if (expectedDailyGap) {
      status = 'HEALTHY';
      diag.findings.push('Candidates exist — awaiting today\'s EOD refresh for strict approvals.');
    } else {
      status = 'DEGRADED';
      diag.primaryIssue = 'Candidates exist but confirmation engine is blocked by stale feed.';
      diag.recommendedActions.push('Restore live feed; the gate will run on the next clean pipeline cycle.');
    }
  } else if (approvedTotal === 0 && candidates > 0) {
    status = 'HEALTHY';
    diag.findings.push('Candidates exist but none cleared the strict approval gate this cycle.');
    diag.findings.push('This can be normal under unsupportive regimes.');
  } else if (approvedTotal > 0) {
    status = 'HEALTHY';
    diag.findings.push(`${approvedTotal} signal${approvedTotal === 1 ? '' : 's'} cleared confirmation.`);
  } else {
    status = 'UNKNOWN';
  }
  return {
    id:                'confirmation',
    name:              'Confirmation Engine',
    category:          'CONFIRMATION',
    status,
    severity:          severityFromStatus(status),
    description:       'Promotes candidates that clear strict institutional gates into approved signals.',
    lastRunAt:         ctx.pipeline.lastConfirmedSignalAt,
    lastSuccessAt:     ctx.pipeline.lastConfirmedSignalAt,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(ctx.pipeline.lastConfirmedSignalAt),
    inputCount:        candidates,
    outputCount:       approvedTotal,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['scoring', 'risk', 'data_feed', 'market_status'],
    blockedBy:         [],
    downstreamImpact:  ['due_diligence', 'reporting'],
    diagnostics:       diag,
    metrics: {
      approvedTotal,
      candidateTotal: candidates,
      buy:            ctx.counters.approvedBuy,
      sell:           ctx.counters.approvedSell,
    },
    links: [{ label: 'Open Signal Engine', href: '/signals' }],
  };
}

/** Rows available for due-diligence review in the current health context. */
function pipelineRowCount(ctx: EngineHealthContext): number {
  const fromCounters = (ctx.counters.approvedTotal ?? 0) + (ctx.counters.candidateTotal ?? 0);
  if (fromCounters > 0) return fromCounters;
  const s = ctx.signals;
  return s.approved.length + s.highPotential.length + s.watchlist.length
    + s.developing.length + s.scannerCandidates.length + s.riskRestricted.length + s.rejected.length;
}

export function buildDueDiligenceHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const summary = ctx.dueDiligenceSummary;
  const reviewed = summary?.totalReviewed ?? 0;
  const rowCount = pipelineRowCount(ctx);
  const signalsEnvelopeReady = ctx.transport.signalsAvailable;
  let status: EngineStatus;
  if (summary && reviewed > 0) {
    status = 'HEALTHY';
    diag.findings.push(`Reviewed ${reviewed} signal${reviewed === 1 ? '' : 's'} across tiers.`);
    if (summary.dataQualityWarnings > 0) diag.warnings.push(`${summary.dataQualityWarnings} data-quality warnings raised.`);
  } else if (!signalsEnvelopeReady) {
    status = 'NOT_CONFIGURED';
    diag.warnings.push('Due Diligence summary not present on the response.');
    diag.recommendedActions.push('Waiting for signal envelope');
  } else if (rowCount > 0) {
    // Due diligence runs in-memory during signals response assembly; lite
    // health probes may omit dueDiligenceSummary even when rows exist.
    status = 'HEALTHY';
    diag.findings.push(
      summary
        ? 'Due diligence envelope present; health sample counted pipeline rows.'
        : `Due diligence ran in-memory on ${rowCount} pipeline row${rowCount === 1 ? '' : 's'}.`,
    );
  } else if (!ctx.marketStatus.isOpen) {
    status = 'HEALTHY';
    diag.findings.push('Market closed — due diligence will run on the next signal envelope.');
  } else {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No pipeline rows available to review yet.');
    diag.recommendedActions.push('Waiting for confirmed or approved candidates');
  }
  const effectiveReviewed = reviewed > 0 ? reviewed : (rowCount > 0 ? rowCount : null);
  return {
    id:                'due_diligence',
    name:              'Due Diligence Engine',
    category:          'DUE_DILIGENCE',
    status,
    severity:          severityFromStatus(status),
    description:       'Generates per-signal explainability and aggregate due-diligence summary.',
    lastRunAt:         ctx.generatedAt ?? null,
    lastSuccessAt:     ctx.generatedAt ?? null,
    lastFailureAt:     null,
    freshnessMinutes:  0,
    inputCount:        effectiveReviewed,
    outputCount:       effectiveReviewed,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['confirmation', 'scoring', 'risk'],
    blockedBy:         [],
    downstreamImpact:  ['reporting', 'learning'],
    diagnostics:       diag,
    metrics: {
      totalReviewed:          summary?.totalReviewed       ?? null,
      approvedReviewed:       summary?.approvedReviewed    ?? null,
      highPotentialReviewed:  summary?.highPotentialReviewed ?? null,
      rejectedReviewed:       summary?.rejectedReviewed    ?? null,
      topBlocker:             summary?.topBlockReasons?.[0]?.reason ?? null,
    },
    links: [{ label: 'Open Signal Engine', href: '/signals' }],
  };
}

export function buildDailyReportHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const dr = ctx.dailyReport;
  const rowCount = pipelineRowCount(ctx);
  let status: EngineStatus;
  if (!dr || !dr.available) {
    status = 'NOT_CONFIGURED';
    diag.warnings.push('Daily report not available on this request.');
    diag.recommendedActions.push('Run report after signal validation');
  } else if (dr.reportStatus === 'COMPLETE') {
    status = 'HEALTHY';
    diag.findings.push('Daily report generated with all measurable sections populated.');
  } else if (dr.reportStatus === 'PARTIAL') {
    // PARTIAL is the normal intraday state: the engine ran, but outcome
    // sections (sector win-rate, indicator performance, etc.) await
    // post-signal data. This is not engine degradation.
    status = 'HEALTHY';
    diag.findings.push('Daily report generated — some outcome sections await post-signal data.');
  } else if (dr.reportStatus === 'PENDING') {
    status = 'HEALTHY';
    diag.findings.push('Daily report is queued for the next signal envelope.');
  } else if (dr.reportStatus === 'INSUFFICIENT_DATA') {
    if (rowCount > 0 || !ctx.marketStatus.isOpen) {
      status = 'HEALTHY';
      diag.findings.push(
        rowCount > 0
          ? 'Daily report ran on the current pipeline — outcome sections not measurable yet.'
          : 'Market closed — daily report will populate on the next session envelope.',
      );
    } else {
      status = 'INSUFFICIENT_DATA';
      diag.primaryIssue = 'Daily report has no measurable data yet.';
    }
  } else {
    status = dr.generatedAt ? 'HEALTHY' : 'UNKNOWN';
    if (status === 'HEALTHY') {
      diag.findings.push('Daily report envelope present without a recognised status code.');
    }
  }
  if (dr?.warnings && dr.warnings.length > 0) diag.warnings.push(...dr.warnings.slice(0, 3));
  return {
    id:                'daily_report',
    name:              'Daily Report Engine',
    category:          'REPORTING',
    status,
    severity:          severityFromStatus(status),
    description:       'Builds Daily Signal Intelligence Report from current pools + due-diligence data.',
    lastRunAt:         dr?.generatedAt ?? null,
    lastSuccessAt:     dr?.generatedAt ?? null,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(dr?.generatedAt ?? null),
    inputCount:        null,
    outputCount:       null,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['due_diligence', 'confirmation'],
    blockedBy:         [],
    downstreamImpact:  ['learning'],
    diagnostics:       diag,
    metrics: { reportStatus: dr?.reportStatus ?? null },
    links: [{ label: 'Open Daily Report', href: '/signals/daily-report' }],
  };
}

export function buildBacktestingHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const bt = ctx.backtest;
  let status: EngineStatus;
  if (!bt || !bt.available) {
    status = 'NOT_CONFIGURED';
    diag.warnings.push('Backtest preview not provided on this request.');
    diag.recommendedActions.push('Import historical candle data');
  } else if (bt.status === 'COMPLETE') {
    status = 'HEALTHY';
  } else if (bt.status === 'PARTIAL') {
    status = 'WARNING';
    diag.primaryIssue = 'Backtest partial — outcome data unavailable for some symbols.';
  } else if (bt.status === 'INSUFFICIENT_DATA') {
    status = 'INSUFFICIENT_DATA';
    diag.primaryIssue = 'Historical price data not available for any symbol.';
    diag.recommendedActions.push('Import historical candle data');
  } else if (bt.status === 'FAILED') {
    status = 'BROKEN';
    diag.errors.push('Backtest run failed.');
  } else {
    status = 'UNKNOWN';
  }
  if (bt?.warnings && bt.warnings.length > 0) diag.warnings.push(...bt.warnings.slice(0, 3));
  return {
    id:                'backtesting',
    name:              'Backtesting Engine',
    category:          'BACKTESTING',
    status,
    severity:          severityFromStatus(status),
    description:       'Validates signal logic, indicator reliability, thresholds, and missed-opportunity patterns.',
    lastRunAt:         bt?.generatedAt ?? null,
    lastSuccessAt:     bt?.generatedAt ?? null,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(bt?.generatedAt ?? null),
    inputCount:        bt?.totalSymbols    ?? null,
    outputCount:       bt?.symbolsWithData ?? null,
    errorCount:        bt?.status === 'FAILED' ? 1 : 0,
    warningCount:      diag.warnings.length,
    dependencies:      ['confirmation', 'data_feed'],
    blockedBy:         [],
    downstreamImpact:  ['learning'],
    diagnostics:       diag,
    metrics: { window: bt?.window ?? null, status: bt?.status ?? null },
    links: [{ label: 'Open Backtesting Lab', href: '/signals/backtesting' }],
  };
}

export function buildLearningHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  // Learning engine = recommendations generated by due-diligence + daily
  // report. We don't persist them yet, so this engine is NOT_CONFIGURED
  // until Phase 6 wires `q365_signal_learning_observations`.
  const summary = ctx.dueDiligenceSummary;
  const hasObservations = !!summary && summary.totalReviewed > 0;
  let status: EngineStatus;
  if (!hasObservations) {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('No reviewed rows available to derive learning observations.');
  } else {
    status = 'NOT_CONFIGURED';
    diag.warnings.push('Learning observations table not yet wired (Phase 6).');
    diag.findings.push('Recommendations are produced in-memory by Phase 2 and Phase 3 today.');
    diag.recommendedActions.push('Apply migration 011_q365_daily_signal_reports.sql.proposal (learning observations table) and wire the writer.');
  }
  return {
    id:                'learning',
    name:              'Learning / Review Engine',
    category:          'LEARNING',
    status,
    severity:          severityFromStatus(status),
    description:       'Captures governance-flagged learning observations; persistence pending Phase 6.',
    lastRunAt:         null,
    lastSuccessAt:     null,
    lastFailureAt:     null,
    freshnessMinutes:  null,
    inputCount:        summary?.totalReviewed ?? null,
    outputCount:       null,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['due_diligence', 'daily_report', 'backtesting'],
    blockedBy:         [],
    downstreamImpact:  [],
    diagnostics:       diag,
    metrics: { phase6Pending: true },
    links: [{ label: 'Open Daily Report', href: '/signals/daily-report' }],
  };
}

// ── PHASE_B_MANIPULATION — Manipulation Risk Engine node ───────
//
// Derives node health from the manipulationRisk envelopes attached to
// every reviewed signal. We DO NOT re-query the manipulation tables
// here — the responseAssembly pipeline already fetched them once per
// /api/signals cycle, and every row carries the same global freshness
// snapshot. Falling back to NOT_CONFIGURED when no envelope is present
// keeps the node honest about whether the integration is wired.
export function buildManipulationHealthNode(ctx: EngineHealthContext): EngineHealthNode {
  const diag = emptyDiagnostics();
  const reviewed = [
    ...ctx.signals.approved, ...ctx.signals.highPotential,
    ...ctx.signals.watchlist, ...ctx.signals.developing,
    ...ctx.signals.scannerCandidates, ...ctx.signals.riskRestricted,
    ...ctx.signals.rejected,
  ] as Array<{ symbol?: string | null; tradingsymbol?: string | null; manipulationRisk?: import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk }>;
  const withRisk = reviewed.filter((r) => !!r.manipulationRisk);
  const firstRisk = withRisk[0]?.manipulationRisk;

  let symbolsWithRisk = 0;
  let severeRiskSymbols = 0;
  let staleRiskSymbols = 0;
  for (const r of withRisk) {
    const m = r.manipulationRisk!;
    if (m.band !== 'LOW' && m.band !== 'UNKNOWN') symbolsWithRisk++;
    if (m.band === 'SEVERE')                       severeRiskSymbols++;
    if (m.freshnessStatus !== 'FRESH' && m.band !== 'LOW' && m.band !== 'UNKNOWN') staleRiskSymbols++;
  }

  // Engine state derivation per spec STEP_9.
  let status: EngineStatus;
  const freshness = firstRisk?.freshnessStatus ?? 'NO_DATA';
  if (!firstRisk) {
    status = 'NOT_CONFIGURED';
    diag.warnings.push('Signal Engine has not received a manipulation risk envelope this cycle.');
    diag.recommendedActions.push('Wire getManipulationRiskForSymbols into responseAssembly (Phase B).');
  } else if (freshness === 'NO_DATA') {
    status = 'INSUFFICIENT_DATA';
    diag.warnings.push('Manipulation engine has no events on record yet — run a scan.');
  } else if (freshness === 'STALE') {
    status = 'STALE';
    diag.primaryIssue = `Manipulation data is stale (latest event ${firstRisk.latestEventDate ?? '—'}). ` +
      'Hard rejection disabled — Signal Engine sees warnings only until fresh scan runs.';
    diag.recommendedActions.push('Run the manipulation scan worker.');
  } else if (freshness === 'PARTIAL') {
    status = 'DEGRADED';
    diag.primaryIssue = 'Manipulation events exist but no snapshot persisted in the last 30 days.';
  } else if (severeRiskSymbols > 0) {
    status = 'WARNING';
    diag.findings.push(`${severeRiskSymbols} symbol(s) at SEVERE manipulation risk in current pool.`);
  } else {
    status = 'HEALTHY';
  }

  const signalEngineIntegrationActive = !!firstRisk;
  const hardRejectionEnabled = freshness === 'FRESH';
  const warningOnlyMode      = !hardRejectionEnabled;

  return {
    id:                'manipulation',
    name:              'Manipulation Risk Engine',
    category:          'RISK',
    status,
    severity:          severityFromStatus(status),
    description:       'Surveillance gate: penalises / risk-restricts / blocks signals on fresh manipulation evidence; warning-only when data is stale.',
    lastRunAt:         firstRisk?.latestScanAt ?? null,
    lastSuccessAt:     firstRisk?.latestScanAt ?? null,
    lastFailureAt:     null,
    freshnessMinutes:  minutesSince(firstRisk?.latestScanAt ?? null),
    inputCount:        reviewed.length,
    outputCount:       withRisk.length,
    errorCount:        0,
    warningCount:      diag.warnings.length,
    dependencies:      ['data_feed'],
    blockedBy:         [],
    downstreamImpact:  ['confirmation'],
    diagnostics:       diag,
    metrics: {
      latestEventDate:           firstRisk?.latestEventDate ?? null,
      latestScanAt:              firstRisk?.latestScanAt ?? null,
      symbolsWithRisk,
      severeRiskSymbols,
      staleRiskSymbols,
      signalEngineIntegrationActive,
      hardRejectionEnabled,
      warningOnlyMode,
      freshnessStatus:           freshness,
    },
    links: [
      { label: 'Open Manipulation Watch', href: '/manipulation' },
      { label: 'Engine Health API',       href: '/api/manipulation?action=health' },
    ],
  };
}

// ── Pipeline readiness + overall status ────────────────────────

/** WARNING states that reflect normal operation — not overall degradation. */
function isBenignWarningNode(node: EngineHealthNode): boolean {
  if (node.status !== 'WARNING') return false;
  const issue = (node.diagnostics.primaryIssue ?? '').toLowerCase();
  switch (node.id) {
    case 'data_feed':
      return issue.includes('market is closed')
        || issue.includes('eod candle')
        || issue.includes('last session')
        || issue.includes('daily feed updates')
        || issue.includes('aging')
        || issue.includes('awaiting today');
    case 'confirmation':
      return issue.includes('market is closed')
        || issue.includes('none cleared')
        || issue.includes('strict approval')
        || issue.includes('candidates exist')
        || issue.includes('awaiting today');
    case 'scanner':
      return issue.includes('zero candidates')
        || issue.includes('envelope unavailable')
        || issue.includes('envelope delayed')
        || issue.includes('normal in unfavourable')
        || issue.includes('awaiting today')
        || issue.includes('session cycle')
        || issue.includes('behind expected');
    case 'daily_report':
      return issue.includes('partial')
        || issue.includes('awaiting post-signal')
        || issue.includes('outcome sections')
        || issue.includes('not measurable yet');
    default:
      return false;
  }
}

const OPTIONAL_HEALTH_NODE_IDS = new Set([
  'daily_report',
  'backtesting',
  'learning',
  'manipulation',
]);

const CORE_HEALTH_NODE_IDS = [
  'data_feed',
  'scanner',
  'scoring',
  'confirmation',
] as const;

export function buildPipelineReadiness(nodes: EngineHealthNode[]): PipelineReadiness {
  const byId = new Map<string, EngineHealthNode>();
  for (const n of nodes) byId.set(n.id, n);
  const blockingReasons: string[] = [];
  const broken = (id: string): boolean => {
    const n = byId.get(id);
    if (!n) return true;
    return n.status === 'BROKEN' || n.status === 'DEGRADED';
  };
  const staleOrBroken = (id: string): boolean => {
    const n = byId.get(id);
    if (!n) return true;
    return n.status === 'BROKEN' || n.status === 'DEGRADED' || n.status === 'STALE';
  };
  const partialOk = (id: string): boolean => {
    const n = byId.get(id);
    if (!n) return false;
    return n.status === 'HEALTHY' || n.status === 'WARNING';
  };

  // Candidates require data feed (or bootstrap) + scanner + scoring.
  const canGenerateCandidates =
       partialOk('data_feed')
    && !staleOrBroken('scanner')
    && !broken('scoring');
  if (!canGenerateCandidates) {
    if (!partialOk('data_feed')) blockingReasons.push('Data feed unavailable for candidate generation.');
    if (staleOrBroken('scanner'))  blockingReasons.push('Scanner engine is broken or stale.');
    if (broken('scoring'))         blockingReasons.push('Scoring engine missing factor scores.');
  }

  // Approved signals require everything to be HEALTHY/WARNING.
  const canGenerateApprovedSignals =
       partialOk('data_feed')
    && partialOk('market_status')
    && !staleOrBroken('scanner')
    && partialOk('scoring')
    && partialOk('risk')
    && (byId.get('confirmation')?.status === 'HEALTHY' || byId.get('confirmation')?.status === 'WARNING');
  if (!canGenerateApprovedSignals) {
    const feed = byId.get('data_feed');
    if (feed && (feed.status === 'STALE' || feed.status === 'DEGRADED' || feed.status === 'BROKEN')) {
      blockingReasons.push(`Data feed ${feed.status.toLowerCase()} — approvals withheld.`);
    }
    const conf = byId.get('confirmation');
    if (conf && conf.status !== 'HEALTHY' && conf.status !== 'WARNING') {
      blockingReasons.push(`Confirmation engine ${conf.status.toLowerCase()}.`);
    }
    if (broken('scoring')) blockingReasons.push('Scoring engine degraded.');
    if (broken('risk'))    blockingReasons.push('Risk engine degraded.');
  }

  const canRunDueDiligence = partialOk('due_diligence');
  if (!canRunDueDiligence) {
    const dd = byId.get('due_diligence');
    if (dd?.status === 'NOT_CONFIGURED') {
      blockingReasons.push('Due-diligence summary not generated for this request.');
    } else if (dd?.status === 'INSUFFICIENT_DATA') {
      blockingReasons.push('Due diligence has no rows to review yet.');
    } else if (dd) {
      blockingReasons.push(`Due diligence engine ${dd.status.toLowerCase()}.`);
    } else {
      blockingReasons.push('Due-diligence engine not mapped.');
    }
  }

  const dr = byId.get('daily_report');
  const canRunDailyReport = dr?.status === 'HEALTHY' || dr?.status === 'WARNING';
  if (!canRunDailyReport) blockingReasons.push('Daily report engine cannot run yet.');

  const bt = byId.get('backtesting');
  const canRunBacktest = bt?.status === 'HEALTHY' || bt?.status === 'WARNING';
  if (!canRunBacktest) blockingReasons.push('Backtesting engine missing historical data.');

  return {
    canGenerateApprovedSignals,
    canGenerateCandidates,
    canRunDueDiligence,
    canRunDailyReport,
    canRunBacktest,
    blockingReasons,
  };
}

export function deriveOverallStatus(
  nodes: EngineHealthNode[],
  pipeline?: PipelineReadiness,
): EngineHealthMap['overallStatus'] {
  let broken = 0;
  let coreBad = 0;
  let actionableDegraded = 0;
  let actionableStale = 0;
  let actionableWarning = 0;
  let hasRequiredHealthy = false;

  for (const n of nodes) {
    if (n.status === 'BROKEN') broken++;
    if (CORE_HEALTH_NODE_IDS.includes(n.id as typeof CORE_HEALTH_NODE_IDS[number])) {
      if (n.status === 'DEGRADED' || n.status === 'STALE') coreBad++;
      if (n.status === 'HEALTHY' || n.status === 'WARNING') hasRequiredHealthy = true;
    }
    if (n.status === 'DEGRADED' && !OPTIONAL_HEALTH_NODE_IDS.has(n.id)) {
      actionableDegraded++;
    }
    if (n.status === 'STALE' && CORE_HEALTH_NODE_IDS.includes(n.id as typeof CORE_HEALTH_NODE_IDS[number])) {
      actionableStale++;
    }
    if (n.status === 'WARNING' && !OPTIONAL_HEALTH_NODE_IDS.has(n.id) && !isBenignWarningNode(n)) {
      actionableWarning++;
    }
  }

  if (broken > 0) return 'BROKEN';
  if (pipeline && !pipeline.canGenerateCandidates) return 'DEGRADED';
  if (coreBad >= 2) return 'DEGRADED';
  if (coreBad === 1 || actionableDegraded > 0) return 'WARNING';
  if (actionableStale >= 2 || actionableWarning >= 2) return 'WARNING';
  if (pipeline?.canGenerateCandidates || hasRequiredHealthy) return 'HEALTHY';
  if (actionableWarning > 0 || actionableStale > 0) return 'WARNING';
  return 'HEALTHY';
}

export function buildSignalReadinessExplanation(
  nodes: EngineHealthNode[],
  pipeline: PipelineReadiness,
  signalCounters: EngineHealthContext['counters'],
): string {
  const parts: string[] = [];
  if (pipeline.canGenerateApprovedSignals) {
    parts.push(signalCounters.approvedTotal > 0
      ? `Approved signal generation is operational (${signalCounters.approvedTotal} signal${signalCounters.approvedTotal === 1 ? '' : 's'} shipped this cycle).`
      : 'Approved signal generation is operational; no row cleared the strict gate this cycle.');
  } else {
    parts.push('Approved signal generation is currently blocked.');
    if (pipeline.blockingReasons.length > 0) parts.push(pipeline.blockingReasons[0]);
  }
  if (pipeline.canGenerateCandidates) {
    parts.push(`Candidate pool: ${signalCounters.candidateTotal}.`);
  } else {
    parts.push('Candidate generation is blocked — see Scanner / Scoring engine cards.');
  }
  if (!pipeline.canRunBacktest) {
    parts.push('Backtesting is unavailable because historical data provider is not configured.');
  }
  return parts.join(' ');
}

// ── Edges ──────────────────────────────────────────────────────

const EDGES_DEFINITION: Array<{ from: string; to: string }> = [
  { from: 'data_feed',     to: 'market_status' },
  { from: 'data_feed',     to: 'scanner' },
  { from: 'market_status', to: 'scanner' },
  { from: 'scanner',       to: 'indicators' },
  { from: 'indicators',    to: 'scoring' },
  { from: 'scoring',       to: 'risk' },
  { from: 'risk',          to: 'confirmation' },
  { from: 'confirmation',  to: 'due_diligence' },
  { from: 'due_diligence', to: 'daily_report' },
  { from: 'daily_report',  to: 'backtesting' },
  { from: 'backtesting',   to: 'learning' },
];

function deriveEdgeStatus(from: EngineHealthNode | undefined, to: EngineHealthNode | undefined): EngineHealthEdge['status'] {
  if (!from || !to) return 'WARNING';
  if (from.status === 'BROKEN' || to.status === 'BROKEN')   return 'BROKEN';
  if (from.status === 'STALE' || to.status === 'STALE')     return 'WARNING';
  if (from.status === 'DEGRADED' || to.status === 'DEGRADED') return 'WARNING';
  if (from.status === 'WARNING' || to.status === 'WARNING') return 'WARNING';
  if (from.status === 'NOT_CONFIGURED' || to.status === 'NOT_CONFIGURED') return 'WARNING';
  return 'OK';
}

function buildEdges(nodes: EngineHealthNode[]): EngineHealthEdge[] {
  const ix = new Map<string, EngineHealthNode>();
  for (const n of nodes) ix.set(n.id, n);
  return EDGES_DEFINITION.map((e) => {
    const f = ix.get(e.from);
    const t = ix.get(e.to);
    const status = deriveEdgeStatus(f, t);
    let explanation: string;
    if (status === 'OK') explanation = `${f?.name ?? e.from} → ${t?.name ?? e.to} healthy.`;
    else if (status === 'BROKEN') explanation = `${f?.name ?? e.from} or ${t?.name ?? e.to} is broken.`;
    else explanation = `Edge degraded — see ${f?.name ?? e.from} / ${t?.name ?? e.to} cards.`;
    return { from: e.from, to: e.to, status, explanation };
  });
}

// ── Master orchestrator ────────────────────────────────────────

export function buildEngineHealthMap(ctx: EngineHealthContext): EngineHealthMap {
  const generatedAt = ctx.generatedAt ?? new Date().toISOString();
  const nodes: EngineHealthNode[] = [
    buildDataFeedHealthNode(ctx),
    buildMarketStatusHealthNode(ctx),
    buildScannerHealthNode(ctx),
    buildIndicatorHealthNode(ctx),
    buildScoringHealthNode(ctx),
    buildRiskHealthNode(ctx),
    buildManipulationHealthNode(ctx),
    buildConfirmationHealthNode(ctx),
    buildDueDiligenceHealthNode(ctx),
    buildDailyReportHealthNode(ctx),
    buildBacktestingHealthNode(ctx),
    buildLearningHealthNode(ctx),
  ];

  // Resolve blockedBy from dependencies (any dep not HEALTHY/WARNING).
  const byId = new Map<string, EngineHealthNode>();
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const blockers: string[] = [];
    for (const depId of n.dependencies) {
      const dep = byId.get(depId);
      if (!dep) continue;
      if (dep.status !== 'HEALTHY' && dep.status !== 'WARNING') blockers.push(dep.name);
    }
    n.blockedBy = blockers;
  }

  const edges     = buildEdges(nodes);
  const pipeline  = buildPipelineReadiness(nodes);
  const overall   = deriveOverallStatus(nodes, pipeline);

  // Issue collection.
  const criticalIssues: string[] = [];
  const warningIssues:  string[] = [];
  let healthyCount = 0, warningCount = 0, degradedCount = 0, brokenCount = 0;
  let staleCount = 0, notConfiguredCount = 0;
  for (const n of nodes) {
    if (n.status === 'HEALTHY')       healthyCount++;
    if (n.status === 'WARNING')       warningCount++;
    if (n.status === 'DEGRADED')      degradedCount++;
    if (n.status === 'BROKEN')        brokenCount++;
    if (n.status === 'STALE')         staleCount++;
    if (n.status === 'NOT_CONFIGURED') notConfiguredCount++;
    if (n.diagnostics.primaryIssue) {
      const msg = `${n.name}: ${n.diagnostics.primaryIssue}`;
      if (n.severity === 'CRITICAL' || n.severity === 'HIGH') criticalIssues.push(msg);
      else if (n.severity === 'MEDIUM')                       warningIssues.push(msg);
    }
  }

  const overallSummary = (() => {
    if (overall === 'HEALTHY') {
      return 'All engines operating within institutional health limits.';
    }
    if (overall === 'BROKEN') {
      return 'Pipeline not ready — approval generation is blocked. Inspect the engine cards below.';
    }
    // WARNING / DEGRADED — be specific about which gate is open.
    if (!pipeline.canGenerateCandidates) {
      return 'Pipeline partially ready. Signal approval is restricted until data feed, scanner, and validation stages complete.';
    }
    if (!pipeline.canGenerateApprovedSignals) {
      return 'Pipeline partially ready. Candidates flowing, but approval gate is awaiting clean confirmation conditions.';
    }
    if (overall === 'DEGRADED') {
      return 'Pipeline degraded — some engines need attention before approvals can resume.';
    }
    if (overall === 'WARNING') {
      return 'Pipeline operational; one or more engines reporting warnings.';
    }
    return 'Pipeline status undetermined.';
  })();

  return {
    generatedAt,
    overallStatus:               overall,
    overallSummary,
    criticalIssues,
    warningIssues,
    healthyCount,
    warningCount,
    degradedCount,
    brokenCount,
    staleCount,
    notConfiguredCount,
    nodes,
    edges,
    pipelineReadiness:           pipeline,
    signalReadinessExplanation:  buildSignalReadinessExplanation(nodes, pipeline, ctx.counters),
  };
}

// ── Lightweight preview ───────────────────────────────────────

export interface LightweightHealthPreviewInput {
  marketOpen:        boolean;
  isBootstrap:       boolean;
  /** Provider serving from cache/fallback — not approval-freeze from daily candle age. */
  isFallback:        boolean;
  staleMinutes:      number | null;
  approvedTotal:     number;
  candidateTotal:    number;
  /** From classifyCandleFreshness — daily bars use 24h/72h bands, not 15/45m intraday. */
  freshnessMode?:    'intraday_strict' | 'daily_tolerant';
  feedFrozen?:       boolean;
  freshnessQuality?: 'fresh' | 'aging' | 'stale' | 'frozen' | 'unknown';
}

/** Max age (minutes) for a daily bar from the prior session before we
 *  treat "frozen" as a genuine outage rather than expected EOD cadence. */
export const MAX_EXPECTED_DAILY_GAP_MINUTES = 7 * 24 * 60;

/** Daily-only feeds update once per session — a Friday bar on Monday is
 *  expected until today's EOD ingests. Don't surface DEGRADED for that. */
export function isExpectedDailySessionGap(input: {
  freshnessMode?:     LightweightHealthPreviewInput['freshnessMode'];
  staleMinutes?:      number | null;
  feedFrozen?:        boolean;
  freshnessQuality?:  LightweightHealthPreviewInput['freshnessQuality'];
  feedStaleHigh?:     boolean;
}): boolean {
  if (input.freshnessMode !== 'daily_tolerant') return false;
  const agedOut = input.staleMinutes != null && input.staleMinutes > MAX_EXPECTED_DAILY_GAP_MINUTES;
  if (agedOut) return false;
  return !!(
    input.feedStaleHigh
    || input.feedFrozen
    || input.freshnessQuality === 'frozen'
    || input.freshnessQuality === 'stale'
  );
}

function resolveFeedStaleness(input: LightweightHealthPreviewInput): {
  staleHigh: boolean;
  staleMid:  boolean;
  reason:    string | null;
} {
  const stale = input.staleMinutes;
  const dailyTolerant = input.freshnessMode === 'daily_tolerant';

  if (input.feedFrozen || input.freshnessQuality === 'frozen') {
    return {
      staleHigh: true,
      staleMid:  false,
      reason:    stale != null ? `Provider feed frozen (${stale}m).` : 'Provider feed frozen.',
    };
  }

  if (dailyTolerant) {
    const staleHigh = stale != null && stale > 72 * 60;
    const staleMid = !staleHigh && (
      input.freshnessQuality === 'stale'
      || (stale != null && stale > 24 * 60)
    );
    return {
      staleHigh,
      staleMid,
      reason: staleHigh
        ? `Provider feed frozen (${stale}m).`
        : staleMid
          ? `Provider feed stale (${stale}m).`
          : null,
    };
  }

  const staleHigh = stale != null && stale > 45;
  const staleMid = !staleHigh && stale != null && stale > 15;
  return {
    staleHigh,
    staleMid,
    reason: staleHigh
      ? `Provider feed stale ${stale}m.`
      : staleMid
        ? `Provider feed aging (${stale}m).`
        : null,
  };
}

export function buildLightweightEngineHealthPreview(
  input: LightweightHealthPreviewInput,
): EngineHealthPreview {
  const { staleHigh: feedStaleHigh, staleMid: feedStaleMid, reason: feedStaleReason } =
    resolveFeedStaleness(input);
  let overallStatus: EngineHealthPreview['overallStatus'] = 'HEALTHY';
  let primaryBlockingReason: string | null = null;

  const expectedDailyGap = isExpectedDailySessionGap({
    freshnessMode:    input.freshnessMode,
    staleMinutes:       input.staleMinutes,
    feedFrozen:         input.feedFrozen,
    freshnessQuality:   input.freshnessQuality,
    feedStaleHigh,
  });

  if (input.isBootstrap || input.isFallback) {
    overallStatus = 'DEGRADED';
    primaryBlockingReason = input.isBootstrap
      ? 'Bootstrap data in use — provider not live.'
      : 'Provider in fallback mode.';
  } else if (feedStaleHigh && expectedDailyGap) {
    overallStatus = 'HEALTHY';
    primaryBlockingReason = null;
  } else if (feedStaleHigh) {
    overallStatus = 'DEGRADED';
    primaryBlockingReason = feedStaleReason;
  } else if (feedStaleMid) {
    if (input.freshnessMode === 'daily_tolerant' || expectedDailyGap) {
      overallStatus = 'HEALTHY';
      primaryBlockingReason = null;
    } else {
      overallStatus = 'WARNING';
      primaryBlockingReason = feedStaleReason ?? `Provider feed aging (${input.staleMinutes}m).`;
    }
  }
  // Market closed is expected off-hours — not a degradation. Approvals
  // are naturally withheld; the dashboard should stay in full/monitoring
  // mode rather than "Partial Intelligence Mode".
  // Even when status is HEALTHY at preview level, we honour the "no
  // approvals this cycle" message for transparency.
  const canApprove = input.approvedTotal > 0
    || (overallStatus === 'HEALTHY' && input.marketOpen);
  // Lightweight preview never produces BROKEN — candidates are
  // available unless the universe is empty.
  const canCandidate = input.candidateTotal > 0 || overallStatus !== 'DEGRADED';

  return {
    overallStatus,
    canGenerateApprovedSignals: canApprove,
    canGenerateCandidates:      canCandidate,
    primaryBlockingReason,
    engineHealthUrl:            '/signals/engine-health',
  };
}
