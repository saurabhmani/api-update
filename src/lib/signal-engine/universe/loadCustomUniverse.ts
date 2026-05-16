/// <reference types="node" />
// ════════════════════════════════════════════════════════════════
//  Custom Universe Loader
//
//  Reads an NSE universe (plain text or Excel/.xlsx) and emits a
//  clean { nse, yahoo } pair the Yahoo-driven scanner can consume // @deprecated marker
//  directly. The .txt format is the same one the legacy
//  nseUniverse.json was generated from — see stockUpdate.txt at the
//  repo root for the canonical example.
//
//  Supported file formats
//    • .txt — one symbol per line; '#' starts a comment; blank lines
//             ignored. Stripped of BOM, CRLF normalised.
//    • .xlsx / .xls — first column of the first non-empty sheet is
//             treated as the symbol column. Headers like "Symbol",
//             "Tradingsymbol", "NSE Symbol", "Ticker" are auto-detected
//             and skipped. Subsequent rows are read until the column
//             empties out. Operators ship the source list as Excel
//             without converting to text first.
//
//  Resolution order for the file path:
//    1. explicit `filePath` argument
//    2. process.env.CUSTOM_UNIVERSE_PATH
//    3. <cwd>/stockUpdate.txt
//
//  Validation (applies to both formats)
//    • Trim, strip BOM, uppercase
//    • Drop dups (first occurrence wins, preserves source order)
//    • Strip a trailing ".NS" / ".BO" / ".BSE" suffix if the operator
//      pre-mapped to Yahoo form — the loader re-maps via // @deprecated marker
//      toYahooSymbol so the override table stays authoritative // @deprecated marker
//    • Reject anything that doesn't match the NSE tradingsymbol
//      shape /^[A-Z0-9][A-Z0-9&\-]*$/ — covers RELIANCE, BAJAJ-AUTO,
//      M&M, 360ONE, MCDOWELL-N etc.; rejects whitespace / dots /
//      stray punctuation that would 404 on Yahoo. Excluded symbols // @deprecated marker
//      are returned in `invalid[]` AND logged with their row number
//      so the operator can fix the source file.
//    • Yahoo mapping goes through symbolNormalize.toYahooSymbol so // @deprecated marker
//      the existing override table (M&M → M%26M.NS, TATAMOTORS →
//      TMCV.NS, etc.) is honoured automatically.
//
//  This module deliberately does NOT scan or hit Yahoo. It only // @deprecated marker
//  produces the clean symbol list. The scanner phase consumes the
//  result.
// ════════════════════════════════════════════════════════════════

import * as fs                      from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import * as XLSX                    from 'xlsx';
import { toYahooSymbol }            from '@/lib/marketData/symbolNormalize'; // @deprecated marker

// xlsx 0.18.5's ESM build (xlsx.mjs) does NOT auto-load Node's fs — it
// exports set_fs() and expects the caller to wire fs in. Next.js App
// Router resolves `'xlsx'` to the .mjs file (per the package's
// `"module"` field), so XLSX.readFile() throws `Cannot access file …`
// in production even when the file exists with world-readable
// permissions. The CJS build (xlsx.js) does this automatically at its
// own top level — only the ESM path is broken. Calling set_fs once at
// module load fixes it for every readFile call below. Wrapped in a
// guard because the symbol is only on the ESM build (calling it on
// CJS would be a runtime no-op but the export wouldn't exist).
const xlsxAny = XLSX as unknown as { set_fs?: (fs: unknown) => void };
if (typeof xlsxAny.set_fs === 'function') {
  xlsxAny.set_fs(fs);
}

// ── Public types ─────────────────────────────────────────────────

export interface InvalidUniverseEntry {
  /** Original (pre-uppercase) text from the file, trimmed. */
  raw:    string;
  /** Why we excluded it. Stable enum so callers can branch on it. */
  reason: 'invalid_chars' | 'too_long' | 'yahoo_map_failed' | 'inav_pseudo'; // @deprecated marker
  /** 1-based line number in the source file (helps operators fix it). */
  line:   number;
}

export interface CustomUniverse {
  /** Absolute path the loader resolved and read. */
  source:   string;
  /** ISO timestamp of the load. */
  loadedAt: string;
  /** Clean NSE tradingsymbols, uppercase, deduped, in source order. */
  nse:      string[];
  /** Yahoo tickers parallel to `nse[]` — index i in both arrays // @deprecated marker
   *  refers to the same instrument. */
  yahoo:    string[]; // @deprecated marker
  /** Symbols dropped during validation, with line + reason. */
  invalid:  InvalidUniverseEntry[];
}

// ── Internals ────────────────────────────────────────────────────

const DEFAULT_FILE = 'stockUpdate.txt';
const MAX_SYMBOL_LEN = 25;
// NSE tradingsymbols: alphanumeric, plus `&` (M&M) and `-` (BAJAJ-AUTO,
// MCDOWELL-N). First char must NOT be `&`/`-` (legitimate symbols start
// with A-Z or 0-9 — yes, 360ONE / 21STCENMGM exist).
const NSE_SYMBOL_RE = /^[A-Z0-9][A-Z0-9&\-]*$/;
// *INAV ("Indicative NAV") are NSE-distributed reference price feeds
// for ETFs — not tradeable instruments. They pass the NSE_SYMBOL_RE
// shape check, but Yahoo Finance has no data for them and 404s every // @deprecated marker
// fetch. Drop them up-front so the scanner doesn't burn rate-limit
// budget and the logs aren't flooded with `[YAHOO 4XX]` noise that
// masks real failures.
const INAV_PSEUDO_RE = /INAV$/;

/** Resolve the universe file path using the documented precedence.
 *  Tagged so callers can distinguish a default fallback (no env, no
 *  arg) from an explicit operator choice — when the operator points
 *  CUSTOM_UNIVERSE_PATH at a file that doesn't exist we MUST fail
 *  rather than silently fall back to stockUpdate.txt, otherwise local
 *  and VPS scan completely different universes when the env path
 *  resolves on one box but not the other. */
export function resolveUniversePath(filePath?: string):
  { path: string; source: 'arg' | 'env' | 'default' }
{
  if (filePath && filePath.trim()) {
    return { path: resolvePath(filePath.trim()), source: 'arg' };
  }
  const fromEnv = process.env.CUSTOM_UNIVERSE_PATH;
  if (fromEnv && fromEnv.trim()) {
    return { path: resolvePath(fromEnv.trim()), source: 'env' };
  }
  return { path: resolvePath(process.cwd(), DEFAULT_FILE), source: 'default' };
}

// ── Main loader ──────────────────────────────────────────────────

/**
 * Pull raw rows from a .xlsx/.xls file. Returns a list of
 * `{ raw, line }` records — one per non-empty cell in the
 * symbol column. The first row is assumed to be a header iff
 * its first cell looks like one ("symbol" / "ticker" / etc.).
 */
function readXlsxRows(source: string): Array<{ raw: string; line: number }> {
  const wb = XLSX.readFile(source);
  // Pick the first sheet that has at least one non-empty cell.
  let chosenSheetName: string | null = null;
  let aoa: any[][] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    // header:1 → array-of-arrays; raw:false coerces numbers/dates to text;
    // defval:'' so missing cells become empty string instead of undefined,
    // letting the empty-row break-out work.
    const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '', raw: false }) as any[][];
    if (rows.some((r) => r.some((c) => String(c).trim().length > 0))) {
      chosenSheetName = name;
      aoa = rows;
      break;
    }
  }
  if (!chosenSheetName) return [];

  // Symbol-column header detection. STRONG hints unambiguously
  // identify the tradingsymbol column ("symbol", "tradingsymbol",
  // "ticker", …); WEAK hints are too generic ("instrument", "name")
  // and would fire on irrelevant columns like "Instrument Token"
  // (which holds numeric Kite tokens, NOT the NSE tradingsymbol). // @deprecated marker
  // We pick STRONG hits over WEAK ones; if no hint matches any
  // column, the loader falls back to the first column whose data
  // rows actually look like NSE symbols (alphabetic, ≤25 chars).
  const STRONG_HEADER_HINTS = ['symbol', 'tradingsymbol', 'trading symbol', 'ticker', 'nse symbol', 'scrip', 'scrip name', 'scrip code', 'stock symbol'];
  const WEAK_HEADER_HINTS   = ['name', 'stock', 'instrument'];
  const cellLower = (c: any): string => String(c ?? '').trim().toLowerCase();
  const isStrongHeader = (cell: string): boolean => STRONG_HEADER_HINTS.includes(cell);
  const isWeakHeader   = (cell: string): boolean => WEAK_HEADER_HINTS.includes(cell);
  // A row "looks like data" (vs header) if the majority of its
  // non-empty cells parse as our NSE symbol shape.
  const looksLikeSymbolColumn = (rows: any[][], col: number): boolean => {
    let total = 0, ok = 0;
    for (let r = 0; r < Math.min(rows.length, 50); r++) {
      const v = String(rows[r]?.[col] ?? '').trim().toUpperCase().replace(/\.(NS|BO|BSE)$/i, '');
      if (!v) continue;
      total++;
      if (v.length <= MAX_SYMBOL_LEN && NSE_SYMBOL_RE.test(v)) ok++;
    }
    return total > 0 && ok / total >= 0.6;
  };

  let symbolCol = -1;
  let startRow = 0;
  // 1) First pass — scan the first non-empty row for STRONG headers.
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    if (row.every((c) => String(c).trim() === '')) continue;
    let strongHit = -1;
    let weakHit   = -1;
    for (let c = 0; c < row.length; c++) {
      const v = cellLower(row[c]);
      if (strongHit < 0 && isStrongHeader(v)) strongHit = c;
      else if (weakHit < 0 && isWeakHeader(v)) weakHit = c;
    }
    if (strongHit >= 0) {
      symbolCol = strongHit;
      startRow = r + 1;
    } else if (weakHit >= 0) {
      symbolCol = weakHit;
      startRow = r + 1;
    } else {
      startRow = r;       // no header — start reading from this row
    }
    break;
  }

  // 2) If no header matched, OR the matched column doesn't look like
  //    symbols (header keyword false-match), fall back to whichever
  //    column has data that actually conforms to the NSE shape.
  const dataRows = aoa.slice(startRow);
  if (symbolCol < 0 || !looksLikeSymbolColumn(dataRows, symbolCol)) {
    const colCount = Math.max(0, ...dataRows.slice(0, 50).map((r) => (r ?? []).length));
    let bestCol = -1;
    for (let c = 0; c < colCount; c++) {
      if (looksLikeSymbolColumn(dataRows, c)) { bestCol = c; break; }
    }
    if (bestCol >= 0) {
      if (symbolCol >= 0 && symbolCol !== bestCol) {
        console.warn(
          `[customUniverse] header column ${symbolCol} did not contain NSE-shaped symbols; ` +
          `auto-switched to column ${bestCol} which does.`,
        );
      }
      symbolCol = bestCol;
    } else {
      // Nothing looked like a symbol column. Last resort: column 0.
      symbolCol = 0;
    }
  }

  const out: Array<{ raw: string; line: number }> = [];
  for (let r = startRow; r < aoa.length; r++) {
    const cell = aoa[r]?.[symbolCol];
    const text = String(cell ?? '').trim();
    if (!text) continue;
    out.push({ raw: text, line: r + 1 });   // 1-based for human-friendly errors
  }
  return out;
}

/** Pull rows from a .txt file: one symbol per line, # comments allowed. */
function readTxtRows(source: string): Array<{ raw: string; line: number }> {
  const raw = readFileSync(source, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  const out: Array<{ raw: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    out.push({ raw: t, line: i + 1 });
  }
  return out;
}

/** Pull rows from a .csv file. Handles the canonical NIFTY 500
 *  shape (`Company Name,Industry,Symbol,Series,ISIN Code`) by
 *  detecting a "Symbol" / "Tradingsymbol" / "Ticker" header and
 *  emitting only that column. Falls back to the first column if
 *  no header matches.
 *
 *  Series filter: when a `Series` column is present, only `EQ`
 *  rows are kept (matches the NIFTY 500 cash-equity contract). */
function readCsvRows(source: string): Array<{ raw: string; line: number }> {
  const raw = readFileSync(source, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) return [];

  const SYMBOL_HEADERS = ['symbol', 'tradingsymbol', 'trading symbol', 'ticker', 'nse symbol', 'scrip', 'scrip name', 'scrip code', 'stock symbol'];
  const SERIES_HEADERS = ['series'];

  const splitRow = (s: string): string[] =>
    s.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));

  // First non-empty line is the header.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] && lines[i].trim()) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];

  const header = splitRow(lines[headerIdx]).map((c) => c.toLowerCase());
  let symbolCol = header.findIndex((h) => SYMBOL_HEADERS.includes(h));
  const seriesCol = header.findIndex((h) => SERIES_HEADERS.includes(h));
  // No header match → assume column 0 is symbols and the first row
  // is data, not a header.
  const startRow = symbolCol >= 0 ? headerIdx + 1 : headerIdx;
  if (symbolCol < 0) symbolCol = 0;

  const out: Array<{ raw: string; line: number }> = [];
  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim() || line.trim().startsWith('#')) continue;
    const cells = splitRow(line);
    const sym = cells[symbolCol];
    if (!sym) continue;
    if (seriesCol >= 0) {
      const series = (cells[seriesCol] ?? '').toUpperCase();
      if (series && series !== 'EQ') continue;
    }
    out.push({ raw: sym, line: i + 1 });
  }
  return out;
}

/**
 * Load and validate a custom NSE universe from a text or xlsx file.
 * Throws if the file is missing — invalid SYMBOLS inside the file
 * are returned in `invalid[]`, never thrown.
 */
export function loadCustomUniverse(filePath?: string): CustomUniverse {
  const resolved = resolveUniversePath(filePath);
  const source = resolved.path;

  if (!existsSync(source)) {
    // Explicit operator choice (env or arg) that points at a missing
    // file is ALWAYS fatal — silently falling back to the default
    // would mean local and VPS load different universes when the
    // path resolves on one box but not the other (the exact symptom
    // behind the local-vs-VPS divergence: VPS env points at a Linux
    // path, local has the same env but the path doesn't exist on
    // Windows). Only the implicit default ('default' source — no
    // arg, no env) is allowed to throw with the legacy message.
    if (resolved.source === 'env' || resolved.source === 'arg') {
      throw new Error(
        `[customUniverse] CUSTOM_UNIVERSE_PATH (or arg) resolves to ${source} but the file does not exist. ` +
        `Refusing to fall back to ${DEFAULT_FILE} — environments must agree on the universe. ` +
        `Either fix the path or unset the env to use the in-repo default.`,
      );
    }
    throw new Error(
      `[customUniverse] file not found at ${source}. ` +
      `Pass an explicit path or set CUSTOM_UNIVERSE_PATH.`,
    );
  }

  const ext = extname(source).toLowerCase();
  const rows = (ext === '.xlsx' || ext === '.xls')
    ? readXlsxRows(source)
    : ext === '.csv'
      ? readCsvRows(source)
      : readTxtRows(source);

  const nse:     string[]                 = [];
  const yahoo:   string[]                 = []; // @deprecated marker
  const invalid: InvalidUniverseEntry[]   = [];
  const seen = new Set<string>();

  for (const entry of rows) {
    const trimmed = entry.raw;
    // Strip a trailing ".NS"/".BO"/".BSE" suffix — operators sometimes
    // ship the list pre-mapped to Yahoo form. The loader re-maps via // @deprecated marker
    // toYahooSymbol below so the override table stays authoritative. // @deprecated marker
    let sym = trimmed.toUpperCase();
    sym = sym.replace(/\.(NS|BO|BSE)$/i, '').trim();

    if (sym.length === 0) continue;
    if (sym.length > MAX_SYMBOL_LEN) {
      invalid.push({ raw: trimmed, reason: 'too_long', line: entry.line });
      continue;
    }
    if (!NSE_SYMBOL_RE.test(sym)) {
      invalid.push({ raw: trimmed, reason: 'invalid_chars', line: entry.line });
      continue;
    }
    if (INAV_PSEUDO_RE.test(sym)) {
      invalid.push({ raw: trimmed, reason: 'inav_pseudo', line: entry.line });
      continue;
    }
    if (seen.has(sym)) continue;
    seen.add(sym);

    let mapped: string;
    try {
      mapped = toYahooSymbol(sym); // @deprecated marker
    } catch {
      invalid.push({ raw: trimmed, reason: 'yahoo_map_failed', line: entry.line }); // @deprecated marker
      seen.delete(sym);
      continue;
    }

    nse.push(sym);
    yahoo.push(mapped); // @deprecated marker
  }

  if (invalid.length > 0) {
    const preview = invalid
      .slice(0, 5)
      .map((v) => `"${v.raw}"@L${v.line}(${v.reason})`)
      .join(', ');
    console.warn(
      `[customUniverse] excluded ${invalid.length} invalid symbol(s) ` +
      `from ${source} — first 5: ${preview}` +
      (invalid.length > 5 ? ` …` : ''),
    );
  }

  // Loud success log per the operator's spec — confirms the universe
  // size at a glance without needing validateCustomUniverse().
  console.log(`[universeLoader] TOTAL STOCKS: ${nse.length} (source=${source})`);

  return {
    source,
    loadedAt: new Date().toISOString(),
    nse,
    yahoo, // @deprecated marker
    invalid,
  };
}

// ── Validation / debug helper ────────────────────────────────────

/**
 * Print a human-readable summary of a loaded universe: total count,
 * exclusions, and the first/last 10 symbols paired with their Yahoo // @deprecated marker
 * mapping. Intended for one-shot operator checks; the scanner does
 * not call this on the hot path.
 */
export function validateCustomUniverse(u: CustomUniverse): void {
  const sep = '─'.repeat(60);
  console.log(sep);
  console.log(`[customUniverse] source : ${u.source}`);
  console.log(`[customUniverse] loaded : ${u.loadedAt}`);
  console.log(`[customUniverse] valid  : ${u.nse.length} symbol(s)`);
  console.log(`[customUniverse] invalid: ${u.invalid.length} symbol(s)`);
  console.log(sep);

  const total = u.nse.length;
  const headN = Math.min(10, total);
  const tailStart = Math.max(headN, total - 10);

  if (headN > 0) {
    console.log(`first ${headN}:`);
    for (let i = 0; i < headN; i++) {
      console.log(
        `  ${String(i + 1).padStart(4)}. ${u.nse[i].padEnd(15)} → ${u.yahoo[i]}`, // @deprecated marker
      );
    }
  }
  if (tailStart < total) {
    console.log(`last ${total - tailStart}:`);
    for (let i = tailStart; i < total; i++) {
      console.log(
        `  ${String(i + 1).padStart(4)}. ${u.nse[i].padEnd(15)} → ${u.yahoo[i]}`, // @deprecated marker
      );
    }
  }

  if (u.invalid.length > 0) {
    const previewN = Math.min(10, u.invalid.length);
    console.log(sep);
    console.log(`first ${previewN} excluded:`);
    for (const v of u.invalid.slice(0, previewN)) {
      console.log(`  L${String(v.line).padStart(5)}  "${v.raw}"  reason=${v.reason}`);
    }
  }
  console.log(sep);
}

// ── Script mode ──────────────────────────────────────────────────
// Allow direct execution:
//   npx tsx src/lib/signal-engine/universe/loadCustomUniverse.ts
//   npx tsx src/lib/signal-engine/universe/loadCustomUniverse.ts "stockUpdate 250426.txt"
//   CUSTOM_UNIVERSE_PATH=path/to/file.txt npx tsx src/lib/signal-engine/universe/loadCustomUniverse.ts
//
// Mirrors the dotenv-loading pattern used by migrateSignalEngine.ts so
// CUSTOM_UNIVERSE_PATH can live in .env.local alongside the rest of the
// runtime config.
if (require.main === module) {
  const path = require('path') as typeof import('path');
  require('dotenv').config({
    path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
  });

  const argPath = process.argv.slice(2).find((a) => !a.startsWith('-'));
  try {
    const u = loadCustomUniverse(argPath);
    validateCustomUniverse(u);
    process.exit(u.nse.length > 0 ? 0 : 2);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[customUniverse] failed: ${msg}`);
    process.exit(1);
  }
}
