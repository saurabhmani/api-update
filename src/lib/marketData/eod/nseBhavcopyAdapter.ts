// ════════════════════════════════════════════════════════════════
//  NSE UDiFF Common Bhavcopy adapter — free daily EOD source.
//
//  Downloads the NSE Common Bhavcopy ZIP from the public archives,
//  extracts the embedded CSV using Node's built-in zlib (no extra
//  dependency required), parses one EQ-segment row per symbol, and
//  emits normalised EodCandleRecord[].
//
//  Anti-bot resilience: NSE rejects bare requests with no cookies or
//  generic User-Agents. We perform a single GET against the NSE root
//  to harvest the Set-Cookie jar, then forward those cookies + a
//  realistic browser User-Agent on the archive request. If that still
//  fails (rate-limit, schema change, IP block), the adapter returns
//  status: FAILED with no fake data — the pipeline records this in
//  q365_data_feed_health and the Signal Engine stays warning-only.
//
//  Source URL pattern (CM = Capital Market segment, daily):
//    https://nsearchives.nseindia.com/content/cm/
//      BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
//
//  CSV columns (subset we read):
//    TradDt, TckrSymb, SctySrs, OpnPric, HghPric, LwPric, ClsPric,
//    PrvsClsgPric, TtlTradgVol, TtlTrfVal, TtlNbOfTxsExctd
// ════════════════════════════════════════════════════════════════

import { inflateRawSync } from 'zlib';
import type {
  EodCandleRecord,
  EodFetchResult,
} from './types';

const SOURCE = 'NSE_BHAVCOPY';

const NSE_ROOT = 'https://www.nseindia.com';
const NSE_ARCHIVE_BASE = 'https://nsearchives.nseindia.com/content/cm';

// Realistic browser UA — NSE's edge rejects libcurl / node-fetch defaults
// outright. This UA matches a current Chromium build and is *not* used to
// disguise the request — every Quantorus365 backend identifies itself via
// the X-Quantorus header below.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Equity-only series. Anything outside this set (debentures, ETFs, F&O
// instruments, govt securities) is dropped — the manipulation engine
// only models cash-equity behaviour today.
const EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'BL', 'IT']);

// ── Date helpers ─────────────────────────────────────────────────

/** YYYYMMDD for NSE filename. */
function toNseDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** YYYY-MM-DD ISO date. */
function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isFinite(d.getTime()) ? d : null;
}

// ── Cookie jar ───────────────────────────────────────────────────

/** Concatenate Set-Cookie headers into a Cookie header value. */
function buildCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function warmupSession(timeoutMs: number): Promise<string | null> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(NSE_ROOT, {
      method:  'GET',
      headers: {
        'User-Agent':      BROWSER_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Quantorus':     'eod-ingest/1',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // node-fetch / undici exposes Set-Cookie via getSetCookie() — fall
    // back to the single-header form if unavailable.
    const raw =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : res.headers.get('set-cookie')
            ? [res.headers.get('set-cookie') as string]
            : [];
    if (!raw.length) return null;
    return buildCookieHeader(raw);
  } catch {
    return null;
  }
}

// ── ZIP extraction (single-file ZIP, no dependency) ──────────────

/**
 * Parse one local-file entry from a single-file ZIP archive and return
 * the decompressed bytes. NSE bhavcopy ZIPs contain exactly one CSV
 * stored with DEFLATE (method 8) or as-stored (method 0); both paths
 * are handled.
 */
function extractSingleFileZip(zipBytes: Buffer): { filename: string; data: Buffer } | null {
  // Local File Header signature: 0x04034b50 little-endian.
  if (zipBytes.length < 30) return null;
  if (zipBytes.readUInt32LE(0) !== 0x04034b50) return null;

  const method            = zipBytes.readUInt16LE(8);
  const compressedSize    = zipBytes.readUInt32LE(18);
  const filenameLength    = zipBytes.readUInt16LE(26);
  const extraFieldLength  = zipBytes.readUInt16LE(28);

  const filenameStart = 30;
  const filenameEnd   = filenameStart + filenameLength;
  if (filenameEnd > zipBytes.length) return null;
  const filename = zipBytes.toString('utf8', filenameStart, filenameEnd);

  const dataStart = filenameEnd + extraFieldLength;
  const dataEnd   = dataStart + compressedSize;
  if (dataEnd > zipBytes.length) {
    // Some ZIPs use the data-descriptor (bit 3 of flags) and report
    // compressedSize=0 in the local header. For a single-file ZIP we
    // can safely fall back to "everything until the central directory
    // signature".
    const cdSig = zipBytes.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      dataStart,
    );
    if (cdSig < 0) return null;
    const compressed = zipBytes.slice(dataStart, cdSig);
    return decompressByMethod(method, compressed, filename);
  }

  const compressed = zipBytes.slice(dataStart, dataEnd);
  return decompressByMethod(method, compressed, filename);
}

function decompressByMethod(
  method:     number,
  compressed: Buffer,
  filename:   string,
): { filename: string; data: Buffer } | null {
  if (method === 0) {
    return { filename, data: compressed };
  }
  if (method === 8) {
    try {
      return { filename, data: inflateRawSync(compressed) };
    } catch {
      return null;
    }
  }
  // Other compression methods aren't expected in NSE bhavcopy ZIPs.
  return null;
}

// ── CSV parse — handles quoted fields ────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseNumber(v: string | undefined): number | null {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ── Public API ───────────────────────────────────────────────────

export interface NseBhavcopyOptions {
  /** Target trading date (YYYY-MM-DD). Defaults to most recent weekday. */
  date?:         string;
  /** Override the URL pattern (for testing or mirror endpoints). */
  urlOverride?:  string;
  /** Per-request timeout in ms. Defaults to 25 s. */
  timeoutMs?:    number;
}

/**
 * Most recent weekday on or before `date`. EOD files don't exist on
 * weekends; we don't have an exchange calendar locally so this is a
 * best-effort roll-back. The ingestion pipeline records the actual
 * trade date the adapter used in the response.
 */
function rollBackToWeekday(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  if (day === 0)      d.setUTCDate(d.getUTCDate() - 2); // Sun → Fri
  else if (day === 6) d.setUTCDate(d.getUTCDate() - 1); // Sat → Fri
  return d;
}

function buildArchiveUrl(date: Date): string {
  return `${NSE_ARCHIVE_BASE}/BhavCopy_NSE_CM_0_0_0_${toNseDateKey(date)}_F_0000.csv.zip`;
}

/**
 * Fetch + parse one trading day's NSE bhavcopy. Always resolves —
 * failure is reported via `status: 'FAILED'` rather than thrown so the
 * pipeline can record per-source health without try/catch noise.
 */
export async function fetchNseBhavcopy(
  options: NseBhavcopyOptions = {},
): Promise<EodFetchResult> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const fetchedAt = new Date().toISOString();

  let target: Date;
  if (options.date) {
    const parsed = parseIsoDate(options.date);
    if (!parsed) {
      return {
        source:     SOURCE,
        status:     'FAILED',
        records:    [],
        sourceFile: null,
        tradeDate:  null,
        fetched:    0,
        error:      `Invalid date: ${options.date} (expected YYYY-MM-DD)`,
      };
    }
    target = rollBackToWeekday(parsed);
  } else {
    target = rollBackToWeekday(new Date());
  }

  const url = options.urlOverride ?? buildArchiveUrl(target);
  const tradeDate = toIsoDate(target);

  // ── 1. Warm up the session to harvest cookies. ──
  const cookieHeader = await warmupSession(timeoutMs);
  if (!cookieHeader) {
    return {
      source:     SOURCE,
      status:     'NOT_CONFIGURED',
      records:    [],
      sourceFile: url,
      tradeDate,
      fetched:    0,
      error:      'NSE session warm-up failed (no Set-Cookie). Likely IP-blocked or network restricted.',
      meta:       { stage: 'warmup' },
    };
  }

  // ── 2. Download the archive. ──
  let zipBytes: Buffer;
  let httpStatus = 0;
  let contentLength = 0;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, {
      method:  'GET',
      headers: {
        'User-Agent':      BROWSER_UA,
        'Accept':          'application/zip,application/octet-stream,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.nseindia.com/all-reports',
        'Cookie':          cookieHeader,
        'X-Quantorus':     'eod-ingest/1',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    httpStatus = res.status;
    if (!res.ok) {
      return {
        source:     SOURCE,
        status:     'FAILED',
        records:    [],
        sourceFile: url,
        tradeDate,
        fetched:    0,
        error:      `NSE archive returned HTTP ${res.status}. ` +
                    (res.status === 404
                      ? 'File not yet published for this trade date — try again after 18:00 IST.'
                      : 'Possible anti-bot block or schema change.'),
        meta:       { httpStatus },
      };
    }
    const buf = await res.arrayBuffer();
    zipBytes = Buffer.from(buf);
    contentLength = zipBytes.length;
  } catch (err) {
    return {
      source:     SOURCE,
      status:     'FAILED',
      records:    [],
      sourceFile: url,
      tradeDate,
      fetched:    0,
      error:      `NSE archive fetch error: ${(err as Error).message}`,
      meta:       { httpStatus },
    };
  }

  // Sanity: the smallest legitimate bhavcopy ZIP is > 10 KB. A
  // multi-byte HTML 4xx page can sneak through with status 200 if the
  // edge returns a courtesy page — reject anything too small to be
  // real data.
  if (zipBytes.length < 1024) {
    return {
      source:     SOURCE,
      status:     'FAILED',
      records:    [],
      sourceFile: url,
      tradeDate,
      fetched:    0,
      error:      `NSE archive response was ${zipBytes.length} bytes — too small to be a real bhavcopy.`,
      meta:       { httpStatus, contentLength },
    };
  }

  // ── 3. Extract the CSV. ──
  const entry = extractSingleFileZip(zipBytes);
  if (!entry) {
    return {
      source:     SOURCE,
      status:     'FAILED',
      records:    [],
      sourceFile: url,
      tradeDate,
      fetched:    0,
      error:      'Failed to extract CSV from NSE bhavcopy ZIP — file format may have changed.',
      meta:       { httpStatus, contentLength },
    };
  }

  // ── 4. Parse CSV → EodCandleRecord[]. ──
  const text = entry.data.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    return {
      source:     SOURCE,
      status:     'FAILED',
      records:    [],
      sourceFile: url,
      tradeDate,
      fetched:    0,
      error:      `NSE bhavcopy CSV had only ${lines.length} lines — likely empty.`,
      meta:       { httpStatus, contentLength, csvBytes: entry.data.length },
    };
  }

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = (name: string): number => {
    const i = header.indexOf(name);
    return i; // -1 means missing → parseNumber will return null below
  };

  // UDiFF Common Bhavcopy schema (post-Jul-2024).
  const COL = {
    tradDt:       idx('TradDt'),
    sgmt:         idx('Sgmt'),
    tckrSymb:     idx('TckrSymb'),
    sctySrs:      idx('SctySrs'),
    finInstrmTp:  idx('FinInstrmTp'),
    opnPric:      idx('OpnPric'),
    hghPric:      idx('HghPric'),
    lwPric:       idx('LwPric'),
    clsPric:      idx('ClsPric'),
    prvsClsgPric: idx('PrvsClsgPric'),
    ttlTradgVol:  idx('TtlTradgVol'),
    ttlTrfVal:    idx('TtlTrfVal'),
    ttlNbOfTxs:   idx('TtlNbOfTxsExctd'),
  };

  if (COL.tckrSymb < 0 || COL.clsPric < 0 || COL.tradDt < 0) {
    return {
      source:     SOURCE,
      status:     'FAILED',
      records:    [],
      sourceFile: url,
      tradeDate,
      fetched:    0,
      error:      'NSE bhavcopy CSV header missing required columns (TckrSymb / ClsPric / TradDt).',
      meta:       { httpStatus, header },
    };
  }

  const records: EodCandleRecord[] = [];
  let parsedTradeDate = tradeDate;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < 5) continue;

    const sgmt    = COL.sgmt    >= 0 ? row[COL.sgmt]    : 'CM';
    const finTp   = COL.finInstrmTp >= 0 ? row[COL.finInstrmTp] : 'STK';
    const series  = COL.sctySrs >= 0 ? row[COL.sctySrs] : 'EQ';

    // Drop everything outside cash-equity. Index, F&O, debentures all
    // come through this file too in newer schemas.
    if (sgmt !== 'CM') continue;
    if (finTp !== 'STK' && finTp !== 'EQ') continue;
    if (!EQUITY_SERIES.has(series)) continue;

    const symbol = row[COL.tckrSymb]?.toUpperCase();
    if (!symbol) continue;

    // NSE schema uses YYYY-MM-DD already in the new format.
    const rowDate = (row[COL.tradDt] ?? '').slice(0, 10);
    if (rowDate && /^\d{4}-\d{2}-\d{2}$/.test(rowDate)) {
      parsedTradeDate = rowDate;
    }

    const open  = parseNumber(row[COL.opnPric]);
    const high  = parseNumber(row[COL.hghPric]);
    const low   = parseNumber(row[COL.lwPric]);
    const close = parseNumber(row[COL.clsPric]);
    const prev  = parseNumber(row[COL.prvsClsgPric]);
    const vol   = parseNumber(row[COL.ttlTradgVol]);
    const trf   = parseNumber(row[COL.ttlTrfVal]);
    const trades = parseNumber(row[COL.ttlNbOfTxs]);

    // Skip rows with no close price — nothing useful for the engine.
    if (close == null) continue;

    records.push({
      symbol,
      exchange:         'NSE',
      tradeDate:        parsedTradeDate,
      open,
      high,
      low,
      close,
      previousClose:    prev,
      volume:           vol,
      turnover:         trf,
      trades,
      // The UDiFF common bhavcopy doesn't include delivery quantity —
      // that lives in a separate "Delivery Position" file. Left null
      // so the engine knows it's unavailable rather than zero.
      deliveryQuantity: null,
      deliveryPercent:  null,
      source:           SOURCE,
      sourceFile:       entry.filename,
      fetchedAt,
    });
  }

  return {
    source:     SOURCE,
    status:     records.length > 0 ? 'SUCCESS' : 'FAILED',
    records,
    sourceFile: entry.filename,
    tradeDate:  parsedTradeDate,
    fetched:    records.length,
    error:      records.length === 0
                  ? 'NSE bhavcopy parsed cleanly but produced 0 equity rows — schema may have shifted.'
                  : null,
    meta:       { httpStatus, contentLength, csvBytes: entry.data.length, headerCols: header.length },
  };
}
