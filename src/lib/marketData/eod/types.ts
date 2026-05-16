// ════════════════════════════════════════════════════════════════
//  Free EOD market-data layer — common types.
//
//  Every adapter normalises its source-specific schema into the
//  EodCandleRecord shape below so the ingestion pipeline can upsert
//  candles + enrichment uniformly regardless of source.
//
//  IMPORTANT: this layer NEVER fakes data. If a source fails to
//  download or parse, the adapter returns an EodFetchResult with
//  status FAILED / NOT_CONFIGURED / PARTIAL and a clear error.
// ════════════════════════════════════════════════════════════════

export type Exchange = 'NSE' | 'BSE';

/** Common shape for one trading day of one symbol. */
export interface EodCandleRecord {
  symbol:            string;
  exchange:          Exchange;
  /** ISO date YYYY-MM-DD. */
  tradeDate:         string;
  open:              number | null;
  high:              number | null;
  low:               number | null;
  close:             number | null;
  previousClose:     number | null;
  volume:            number | null;
  /** Total traded value in INR. */
  turnover:          number | null;
  /** Number of trades. */
  trades:            number | null;
  /** Delivered quantity (subset of volume that settled). */
  deliveryQuantity:  number | null;
  /** Delivery quantity / volume × 100. */
  deliveryPercent:   number | null;
  /** Adapter that produced this row, e.g. "NSE_BHAVCOPY". */
  source:            string;
  /** Filename or URL the row was parsed from. */
  sourceFile:        string | null;
  /** ISO timestamp the adapter completed its fetch. */
  fetchedAt:         string;
}

export type FetchStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'NOT_CONFIGURED'
  | 'PARTIAL';

/** One adapter's per-run summary. */
export interface EodFetchResult {
  source:     string;
  status:     FetchStatus;
  /** Records returned by the adapter. */
  records:    EodCandleRecord[];
  /** Filename or URL probed. */
  sourceFile: string | null;
  /** Trading date the adapter targeted (may differ from requested if rolled back). */
  tradeDate:  string | null;
  fetched:    number;
  error:      string | null;
  /** Diagnostic info (HTTP status, content-length, …). */
  meta?:      Record<string, unknown>;
}

/** Per-source upsert outcome captured by the ingestion pipeline. */
export interface EodSourceSummary {
  source:     string;
  status:     FetchStatus;
  fetched:    number;
  inserted:   number;
  updated:    number;
  duplicates: number;
  error:      string | null;
  sourceFile: string | null;
}

/** Top-level ingestion pipeline response. */
export interface EodIngestionResult {
  ok:               boolean;
  tradeDate:        string | null;
  startedAt:        string;
  completedAt:      string;
  sources:          EodSourceSummary[];
  latestCandleDate: string | null;
  warnings:         string[];
}
