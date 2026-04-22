// ════════════════════════════════════════════════════════════════
//  Kite instrument master
//
//  The Kite WebSocket feed is keyed by numeric instrument_token,
//  not by tradingsymbol. We fetch the full NSE dump from
//  https://api.kite.trade/instruments/NSE (CSV, ~2MB, updated daily
//  by Zerodha around 08:00 IST) and persist it to MySQL so we can
//  resolve symbol → token in O(1) without re-downloading on every
//  cold start.
//
//  Refreshed once per UTC day on demand — the first caller after
//  the cutoff pays the download cost; everyone else reads from DB.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'kiteInstruments' });

const CSV_URL = 'https://api.kite.trade/instruments/NSE';
const TIMEOUT_MS = 30_000;

let schemaEnsured = false;

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS kite_instruments (
      instrument_token  BIGINT       PRIMARY KEY,
      exchange_token    BIGINT,
      tradingsymbol     VARCHAR(64)  NOT NULL,
      name              VARCHAR(255),
      segment           VARCHAR(32),
      exchange          VARCHAR(16),
      instrument_type   VARCHAR(16),
      tick_size         DECIMAL(10,4),
      lot_size          INT,
      refreshed_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tsym (tradingsymbol, exchange)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  schemaEnsured = true;
}

export interface KiteInstrument {
  instrument_token: number;
  tradingsymbol: string;
  exchange: string;
  segment: string;
  instrument_type: string;
  lot_size: number;
}

async function isStale(): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT MAX(refreshed_at) AS last FROM kite_instruments`,
  );
  const last = (rows as any[])[0]?.last as Date | null;
  if (!last) return true;
  // Refresh once per calendar day (UTC). Zerodha updates ~02:30 UTC.
  const lastDay = Math.floor(new Date(last).getTime() / 86_400_000);
  const nowDay  = Math.floor(Date.now() / 86_400_000);
  return nowDay > lastDay;
}

function parseCsv(text: string): KiteInstrument[] {
  const lines = text.split(/\r?\n/);
  const out: KiteInstrument[] = [];
  // First line is header:
  // instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,
  // strike,tick_size,lot_size,instrument_type,segment,exchange
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    if (c.length < 12) continue;
    const token = Number(c[0]);
    if (!Number.isFinite(token)) continue;
    // Equity only — skip F&O, indices, bonds
    if (c[9] !== 'EQ') continue;
    out.push({
      instrument_token: token,
      tradingsymbol:    c[2],
      exchange:         c[11],
      segment:          c[10],
      instrument_type:  c[9],
      lot_size:         Number(c[8]) || 1,
    });
  }
  return out;
}

export async function refreshInstruments(force = false): Promise<number> {
  await ensureSchema();
  if (!force && !(await isStale())) {
    const { rows } = await db.query(`SELECT COUNT(*) AS n FROM kite_instruments`);
    return Number((rows as any[])[0]?.n ?? 0);
  }

  console.log('[kiteInstruments] downloading NSE instrument dump…');
  const res = await fetch(CSV_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`instruments CSV HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  console.log(`[kiteInstruments] parsed ${rows.length} NSE EQ rows`);

  // Batch insert — 500 rows per INSERT to keep the packet under mysql
  // max_allowed_packet and avoid locking the table for too long.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const placeholders = slice.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params: unknown[] = [];
    for (const r of slice) {
      params.push(
        r.instrument_token,
        r.tradingsymbol,
        r.exchange,
        r.segment,
        r.instrument_type,
        r.lot_size,
        new Date(),
      );
    }
    await db.query(
      `INSERT INTO kite_instruments
         (instrument_token, tradingsymbol, exchange, segment, instrument_type, lot_size, refreshed_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         tradingsymbol = VALUES(tradingsymbol),
         exchange      = VALUES(exchange),
         segment       = VALUES(segment),
         lot_size      = VALUES(lot_size),
         refreshed_at  = VALUES(refreshed_at)`,
      params,
    );
  }
  return rows.length;
}

// ── In-memory lookup cache ─────────────────────────────────────
// Symbol → token is a hot path (every ticker subscribe call hits
// it), so we keep the whole NSE EQ mapping in a Map after first
// use. Cleared on process restart, which is fine — the DB is the
// source of truth.

const symToToken = new Map<string, number>();
const tokenToSym = new Map<number, string>();
let mapLoaded = false;

/**
 * Seed the in-memory symbol↔token maps from a pre-resolved source
 * (e.g. nseUniverse.json which carries the token inline). Lets the
 * ticker subscribe WITHOUT first succeeding against the live Kite
 * instruments CSV download or the kite_instruments DB table — so a
 * fresh server with an empty DB can still come up streaming.
 *
 * Idempotent: existing entries are overwritten. Does NOT flip
 * `mapLoaded`; the full DB load still runs on the first async call.
 */
export function seedInstrumentMap(entries: Array<{ symbol: string; token: number }>): number {
  let added = 0;
  for (const e of entries) {
    const sym = String(e.symbol ?? '').trim().toUpperCase();
    const tok = Number(e.token);
    if (!sym || !Number.isFinite(tok) || tok <= 0) continue;
    symToToken.set(sym, tok);
    tokenToSym.set(tok, sym);
    added++;
  }
  return added;
}

async function loadMap(): Promise<void> {
  if (mapLoaded) return;
  // Non-throwing: any failure here (CSV download, empty DB) must NOT
  // wipe out a pre-seeded map. Callers need `symToToken` to stay
  // populated from `seedInstrumentMap()` even when Kite's CSV is
  // temporarily unreachable.
  try {
    await ensureSchema();
    await refreshInstruments(false);
    const { rows } = await db.query(
      `SELECT instrument_token, tradingsymbol FROM kite_instruments WHERE exchange = 'NSE'`,
    );
    for (const r of rows as any[]) {
      const sym = String(r.tradingsymbol).toUpperCase();
      symToToken.set(sym, Number(r.instrument_token));
      tokenToSym.set(Number(r.instrument_token), sym);
    }
    mapLoaded = true;
    console.log(`[kiteInstruments] in-memory map loaded (${symToToken.size} entries)`);
  } catch (err) {
    console.warn(
      `[kiteInstruments] loadMap failed: ${(err as Error).message} — ` +
      `falling back to seeded map (${symToToken.size} entries)`
    );
    // Mark loaded only if the seed actually has content; otherwise
    // let a later call retry the DB path.
    if (symToToken.size > 0) mapLoaded = true;
  }
}

export async function getInstrumentToken(symbol: string): Promise<number | null> {
  await loadMap();
  return symToToken.get(symbol.trim().toUpperCase()) ?? null;
}

export async function getSymbolForToken(token: number): Promise<string | null> {
  await loadMap();
  return tokenToSym.get(token) ?? null;
}

export async function resolveTokens(symbols: string[]): Promise<Map<string, number>> {
  await loadMap();
  const out = new Map<string, number>();
  for (const s of symbols) {
    const tok = symToToken.get(s.trim().toUpperCase());
    if (tok != null) out.set(s.toUpperCase(), tok);
  }
  return out;
}
