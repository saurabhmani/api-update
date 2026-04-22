// ════════════════════════════════════════════════════════════════
//  News Intelligence Engine — Type System
//
//  Deterministic schema for all news processing layers.
//  No loose JSON — every field typed, every enum explicit.
// ════════════════════════════════════════════════════════════════

// ── Source Identifiers ───────────────────────────────────────────

export type NewsSourceId = 'gnews' | 'newsdata' | 'rss_et' | 'rss_mc' | 'finnhub'
  | 'official_exchange' | 'corporate_filings' | 'deals_feed' | 'social_signals';

/** Source class categorization for coverage reporting and scoring. */
export type NewsSourceClass = 'official' | 'media' | 'deals' | 'social';

/** Map source IDs to their class for coverage tracking. */
export const SOURCE_CLASS_MAP: Record<NewsSourceId, NewsSourceClass> = {
  gnews:              'media',
  newsdata:           'media',
  rss_et:             'media',
  rss_mc:             'media',
  finnhub:            'media',
  official_exchange:  'official',
  corporate_filings:  'official',
  deals_feed:         'deals',
  social_signals:     'social',
};

export type NewsCategory =
  | 'earnings'
  | 'merger_acquisition'
  | 'regulatory'
  | 'macro_policy'      // RBI, govt policy, budget
  | 'commodity'
  | 'sector_move'
  | 'management_change'
  | 'insider_trade'
  | 'credit_rating'
  | 'ipo_listing'
  | 'global_cue'        // Fed, ECB, geopolitical
  | 'corporate_action'  // splits, dividends, buybacks
  | 'general';

export type SentimentLabel = 'strongly_positive' | 'positive' | 'neutral' | 'negative' | 'strongly_negative';

export type EntityType = 'symbol' | 'sector' | 'macro_factor' | 'commodity';

// ── Raw item from any adapter ────────────────────────────────────

export interface RawNewsItem {
  sourceId:     NewsSourceId;
  externalId:   string;           // source-specific unique id
  title:        string;
  body:         string | null;    // description / summary
  url:          string;
  publishedAt:  string;           // ISO-8601
  fetchedAt:    string;           // ISO-8601
  rawMeta?:     Record<string, unknown>;  // source-specific extras
}

// ── Entity Link ──────────────────────────────────────────────────

export interface EntityLink {
  entityType:   EntityType;
  entityValue:  string;           // e.g. 'RELIANCE', 'Banking', 'crude_oil', 'rbi_rate'
  confidence:   number;           // 0-100
  matchMethod:  'exact' | 'alias' | 'keyword' | 'sector_infer';
}

// ── Normalized NewsEvent (what gets persisted) ───────────────────

export interface NewsEvent {
  id?:            number;
  sourceId:       NewsSourceId;
  externalId:     string;
  dedupHash:      string;         // SHA-256 of normalized title + source
  title:          string;
  body:           string | null;
  url:            string;
  category:       NewsCategory;
  sentiment:      SentimentLabel;
  sentimentScore: number;         // -1.0 to +1.0
  publishedAt:    string;
  fetchedAt:      string;
  entities:       EntityLink[];
  symbols:        string[];       // shortcut: resolved symbols from entities
  sectors:        string[];       // shortcut: resolved sectors
  macroFactors:   string[];       // shortcut: resolved macro factors
  commodities:    string[];       // shortcut: resolved commodities
  isProcessed:    boolean;
}

// ── Adapter Interface ────────────────────────────────────────────

export interface NewsAdapter {
  sourceId: NewsSourceId;
  fetch(query: string, limit: number): Promise<RawNewsItem[]>;
}

// ── Pipeline Result ──────────────────────────────────────────────

export interface IngestionResult {
  totalFetched:   number;
  duplicatesSkipped: number;
  newEvents:      number;
  errors:         string[];
  sourceBreakdown: Record<NewsSourceId, number>;
  sourceClassCoverage?: Record<NewsSourceClass, { attempted: number; succeeded: number; itemCount: number }>;
}

// ── Query Filters ────────────────────────────────────────────────

export interface NewsQueryFilter {
  symbols?:     string[];
  sectors?:     string[];
  categories?:  NewsCategory[];
  sentiment?:   SentimentLabel[];
  fromDate?:    string;
  toDate?:      string;
  limit?:       number;
  offset?:      number;
}
