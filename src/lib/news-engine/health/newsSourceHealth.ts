// ════════════════════════════════════════════════════════════════
//  News source health — tier, state, and operator-facing messages
//
//  Distinguishes:
//    configured  — env present, expected to participate
//    optional    — paid / integration sources without credentials
//    unavailable — configured but fetch failed or returned zero rows
//    active      — configured and returned items in the last run
// ════════════════════════════════════════════════════════════════

import type { NewsSourceId, NewsSourceStatus } from '../types/newsEngine.types';

export type NewsSourceTier =
  | 'always_on'            // public RSS — no API key
  | 'official'             // BSE/NSE exchange announcements
  | 'optional_paid'        // GNews, NewsAPI, etc.
  | 'optional_integration'; // corporate filings, deals, social

export type NewsSourceHealthState =
  | 'active'
  | 'configured'
  | 'optional'
  | 'unavailable'
  | 'not_configured';

/** Fusion-style provider status — aligned with engineHealthMap vocabulary. */
export type NewsProviderFusionStatus =
  | 'HEALTHY'
  | 'OPTIONAL'
  | 'NOT_CONFIGURED'
  | 'UNAVAILABLE'
  | 'INSUFFICIENT_DATA';

export interface NewsSourceHealthRow extends NewsSourceStatus {
  tier:          NewsSourceTier;
  healthState:   NewsSourceHealthState;
  /** Fusion-style status for dashboards and health evaluators. */
  status:        NewsProviderFusionStatus;
  healthMessage: string;
  displayName:   string;
}

export type NewsProviderHealthMap = Record<
  NewsSourceId,
  { status: NewsProviderFusionStatus }
>;

export interface NewsSourceHealthSummary {
  configuredCount:      number;
  activeCount:          number;
  optionalCount:        number;
  unavailableCount:     number;
  notConfiguredCount:   number;
  activeSources:        NewsSourceId[];
  optionalSources:      NewsSourceId[];
  unavailableSources:   NewsSourceId[];
  /** Required/official sources missing env — not the same as optional. */
  notConfiguredSources: NewsSourceId[];
  /** BSE/NSE exchange sub-feed status (from last probe or ingestion). */
  exchangeFeeds?:       ExchangeFeedHealth;
  /** Optional premium integrations not yet wired — expected gaps. */
  integrationGaps?:     NewsSourceId[];
  sources:              NewsSourceHealthRow[];
  warnings:             string[];
}

export interface ExchangeFeedHealth {
  bse: { active: boolean; fetched: number; label: string };
  nse: { active: boolean; fetched: number; label: string };
}

const PREMIUM_INTEGRATION_SOURCES: NewsSourceId[] = [
  'corporate_filings', 'deals_feed', 'social_signals',
];

const SOURCE_META: Record<NewsSourceId, { tier: NewsSourceTier; displayName: string; envHint: string }> = {
  official_exchange: { tier: 'official',             displayName: 'Exchange announcements (BSE/NSE)', envHint: 'BSE_ANNOUNCEMENTS_RSS / NSE_ANNOUNCEMENTS_RSS' },
  corporate_filings: { tier: 'optional_integration', displayName: 'Corporate filings API',            envHint: 'CORPORATE_FILINGS_API_URL (see docs/PREMIUM_NEWS_FEEDS.md)' },
  deals_feed:        { tier: 'optional_integration', displayName: 'Deals feed API',                   envHint: 'DEALS_FEED_API_URL (see docs/PREMIUM_NEWS_FEEDS.md)' },
  social_signals:    { tier: 'optional_integration', displayName: 'Social signals API',               envHint: 'SOCIAL_SIGNALS_API_URL (see docs/PREMIUM_NEWS_FEEDS.md)' },
  gnews:             { tier: 'optional_paid',        displayName: 'GNews',                            envHint: 'GNEWS_API_KEY' },
  newsdata:          { tier: 'optional_paid',        displayName: 'NewsData.io',                      envHint: 'NEWSDATA_API_KEY' },
  newsapi:           { tier: 'optional_paid',        displayName: 'NewsAPI',                          envHint: 'NEWSAPI_KEY / NEWSAPI_API_KEY' },
  finnhub:           { tier: 'optional_paid',        displayName: 'Finnhub',                          envHint: 'FINNHUB_API_KEY' },
  rss_et:            { tier: 'always_on',            displayName: 'Economic Times RSS',               envHint: 'public feed' },
  rss_mc:            { tier: 'always_on',            displayName: 'MoneyControl RSS',                 envHint: 'public feed' },
};

function envUrlSet(key: string): boolean {
  return !!process.env[key]?.trim();
}

/** Env contract per adapter — keep in sync with ingestAll adapters. */
export function isSourceConfigured(source: NewsSourceId): boolean {
  switch (source) {
    case 'gnews':              return !!process.env.GNEWS_API_KEY?.trim();
    case 'newsdata':           return !!process.env.NEWSDATA_API_KEY?.trim();
    case 'newsapi':            return !!(process.env.NEWSAPI_KEY?.trim() || process.env.NEWSAPI_API_KEY?.trim());
    case 'finnhub':            return !!process.env.FINNHUB_API_KEY?.trim();
    case 'rss_et':             return true;
    case 'rss_mc':             return true;
    case 'official_exchange':  return !!(envUrlSet('BSE_ANNOUNCEMENTS_RSS') || envUrlSet('NSE_ANNOUNCEMENTS_RSS'));
    case 'corporate_filings':  return envUrlSet('CORPORATE_FILINGS_API_URL');
    case 'deals_feed':         return envUrlSet('DEALS_FEED_API_URL');
    case 'social_signals':     return envUrlSet('SOCIAL_SIGNALS_API_URL');
  }
}

function resolveHealthState(
  tier: NewsSourceTier,
  row: Pick<NewsSourceStatus, 'configured' | 'fetched' | 'error'>,
  hasRunData = true,
): NewsSourceHealthState {
  if (!row.configured) {
    // Optional integrations are reported unavailable (not wired) but remain
    // optional — no operator warning is emitted.
    if (tier === 'optional_integration') return 'unavailable';
    if (tier === 'optional_paid') return 'optional';
    return 'not_configured';
  }
  if (row.error) return 'unavailable';
  if (row.fetched > 0) return 'active';
  if (tier === 'official' && hasRunData) return 'unavailable';
  return 'configured';
}

function isOptionalTier(tier: NewsSourceTier): boolean {
  return tier === 'optional_paid' || tier === 'optional_integration';
}

export function deriveProviderStatus(
  healthState: NewsSourceHealthState,
  tier: NewsSourceTier,
  configured: boolean,
): NewsProviderFusionStatus {
  switch (healthState) {
    case 'active':
      return 'HEALTHY';
    case 'configured':
      return 'INSUFFICIENT_DATA';
    case 'optional':
      return 'OPTIONAL';
    case 'unavailable':
      return isOptionalTier(tier) && !configured ? 'OPTIONAL' : 'UNAVAILABLE';
    case 'not_configured':
      return 'NOT_CONFIGURED';
  }
}

/** Per-provider fusion status map — e.g. { official_exchange: { status: 'HEALTHY' } }. */
export function buildProviderHealthMap(
  rows: NewsSourceHealthRow[],
): NewsProviderHealthMap {
  return Object.fromEntries(
    rows.map((r) => [r.source, { status: r.status }]),
  ) as NewsProviderHealthMap;
}

function buildHealthMessage(
  meta: (typeof SOURCE_META)[NewsSourceId],
  state: NewsSourceHealthState,
  fetched: number,
  error: string | null,
  configured: boolean,
): string {
  switch (state) {
    case 'active':
      return `${meta.displayName} active — ${fetched} item(s) in last run`;
    case 'configured':
      return `${meta.displayName} configured — no items in last run yet`;
    case 'optional':
      return `Optional — ${meta.envHint} not set`;
    case 'unavailable':
      if (!configured && isOptionalTier(meta.tier)) {
        return `Optional — ${meta.displayName} unavailable (${meta.envHint} not set)`;
      }
      return error
        ? `${meta.displayName} unavailable — ${error}`
        : `${meta.displayName} unavailable — configured but returned 0 items`;
    case 'not_configured':
      return `${meta.displayName} not configured — set ${meta.envHint}`;
  }
}

export function enrichSourceHealth(
  row: NewsSourceStatus,
  hasRunData = true,
): NewsSourceHealthRow {
  const meta = SOURCE_META[row.source];
  const healthState = resolveHealthState(meta.tier, row, hasRunData);
  const status = deriveProviderStatus(healthState, meta.tier, row.configured);
  return {
    ...row,
    tier:          meta.tier,
    healthState,
    status,
    displayName:   meta.displayName,
    healthMessage: buildHealthMessage(meta, healthState, row.fetched, row.error, row.configured),
  };
}

export function buildConfiguredSourcesSnapshot(): NewsSourceHealthRow[] {
  const ids = Object.keys(SOURCE_META) as NewsSourceId[];
  return ids.map((source) => enrichSourceHealth({
    source,
    configured:    isSourceConfigured(source),
    fetched:       0,
    error:         null,
    lastFetchedAt: null,
  }));
}

export function buildSourceHealthSummary(
  rows: NewsSourceHealthRow[],
  adapterErrors: string[] = [],
): NewsSourceHealthSummary {
  const activeSources       = rows.filter((r) => r.healthState === 'active').map((r) => r.source);
  const optionalSources     = rows.filter((r) => isOptionalTier(r.tier)).map((r) => r.source);
  const unavailableSources  = rows.filter((r) => r.healthState === 'unavailable').map((r) => r.source);
  const notConfiguredSources = rows.filter((r) => r.healthState === 'not_configured').map((r) => r.source);

  const warnings: string[] = [];

  for (const row of rows) {
    if (row.healthState === 'not_configured') {
      warnings.push(row.healthMessage);
    } else if (row.healthState === 'unavailable' && !isOptionalTier(row.tier)) {
      warnings.push(row.healthMessage);
    } else if (row.healthState === 'unavailable' && row.configured) {
      warnings.push(row.healthMessage);
    }
  }

  for (const err of adapterErrors) {
    if (!warnings.some((w) => w.includes(err))) {
      warnings.push(err);
    }
  }

  return {
    configuredCount:    rows.filter((r) => r.configured).length,
    activeCount:        activeSources.length,
    optionalCount:      optionalSources.length,
    unavailableCount:   unavailableSources.length,
    notConfiguredCount: notConfiguredSources.length,
    activeSources,
    optionalSources,
    unavailableSources,
    notConfiguredSources,
    integrationGaps: PREMIUM_INTEGRATION_SOURCES.filter((id) =>
      unavailableSources.includes(id),
    ),
    sources: rows,
    warnings,
  };
}

/** Derive BSE/NSE sub-feed counts from ingested official_exchange items. */
export function buildExchangeFeedHealth(
  items: Array<{ rawMeta?: Record<string, unknown> }>,
): ExchangeFeedHealth {
  const bseCount = items.filter((i) => String(i.rawMeta?.source ?? '').startsWith('bse')).length;
  const nseCount = items.filter((i) => String(i.rawMeta?.source ?? '').startsWith('nse')).length;
  return {
    bse: { active: bseCount > 0, fetched: bseCount, label: 'BSE announcements' },
    nse: { active: nseCount > 0, fetched: nseCount, label: 'NSE announcements' },
  };
}

export function attachExchangeFeedHealth(
  summary: NewsSourceHealthSummary,
  items: Array<{ rawMeta?: Record<string, unknown> }>,
): NewsSourceHealthSummary {
  return { ...summary, exchangeFeeds: buildExchangeFeedHealth(items) };
}

/** Merge env snapshot with per-run fetch counts from the audit log. */
export function mergeRunBreakdown(
  snapshot: NewsSourceHealthRow[],
  breakdown: Record<string, number>,
  runAt: string | null,
  adapterErrors: string[] = [],
): NewsSourceHealthSummary {
  const hasRunData = !!runAt;
  const rows = snapshot.map((base) => {
    const fetched = Number(breakdown[base.source] ?? 0);
    const merged = enrichSourceHealth({
      ...base,
      fetched,
      lastFetchedAt: runAt,
      error: adapterErrors.find((e) => e.startsWith(`${base.source}:`))?.split(': ').slice(1).join(': ') ?? null,
    }, hasRunData);
    return merged;
  });
  return buildSourceHealthSummary(rows, adapterErrors);
}

/**
 * Warnings emitted after an ingestion run. Only legitimate issues —
 * optional paid/integration sources without env keys are NOT warned.
 */
export function collectIngestionHealthWarnings(rows: NewsSourceHealthRow[]): string[] {
  return rows
    .filter((r) => {
      if (r.healthState === 'not_configured') return true;
      if (r.healthState === 'unavailable' && isOptionalTier(r.tier) && !r.configured) return false;
      if (r.healthState === 'unavailable') return true;
      return false;
    })
    .map((r) => r.healthMessage);
}

const EXCHANGE_WARNING_TOKENS = [
  'exchange announcements',
  'bse_announcements_rss',
  'nse_announcements_rss',
  'official_exchange',
  'bse announcements',
  'nse announcements',
];

/** Operator warnings excluding exchange configuration noise (Scenario D). */
export function collectNonExchangeHealthWarnings(rows: NewsSourceHealthRow[]): string[] {
  return collectIngestionHealthWarnings(rows).filter(
    (w) => !EXCHANGE_WARNING_TOKENS.some((token) => w.toLowerCase().includes(token)),
  );
}
