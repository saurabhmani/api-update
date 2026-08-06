/**
 * Pre-scan warehouse readiness. Scans must not silently succeed against
 * an empty or stale candle warehouse.
 *
 * `market_data_daily` is a view over `candles` with column `ts` (not trading_date).
 */
import { db } from '@/lib/db';

export interface WarehouseHealthReport {
  ok: boolean;
  universeCount: number;
  symbolsWithEnoughBars: number;
  latestCandleDate: string | null;
  staleSymbolCount: number;
  minBarsRequired: number;
  maxStaleDays: number;
  indianApiBreakerState: string;
  reason?: string;
}

function istYmd(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function daysBetweenIst(aYmd: string, bYmd: string): number {
  const a = Date.parse(`${aYmd}T00:00:00+05:30`);
  const b = Date.parse(`${bYmd}T00:00:00+05:30`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round((b - a) / 86_400_000);
}

function toYmd(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return istYmd(value);
  const s = String(value);
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

export async function checkWarehouseHealth(opts?: {
  minBars?: number;
  maxStaleDays?: number;
  minReadySymbols?: number;
}): Promise<WarehouseHealthReport> {
  const minBars = opts?.minBars ?? Number(process.env.SCAN_MIN_BARS || 240);
  const maxStaleDays = opts?.maxStaleDays ?? Number(process.env.SCAN_MAX_STALE_DAYS || 5);
  const minReadySymbols = opts?.minReadySymbols ?? Number(process.env.SCAN_MIN_READY_SYMBOLS || 50);

  let indianApiBreakerState = 'unknown';
  try {
    const { getIndianApiHistoricalCircuitState } = await import(
      '@/lib/marketData/providers/indianApiHistoricalCircuit'
    );
    const st = getIndianApiHistoricalCircuitState();
    indianApiBreakerState = st.open
      ? `open_until=${st.resumeAfterIso ?? 'unknown'}`
      : 'closed';
  } catch {
    indianApiBreakerState = 'unavailable';
  }

  try {
    const { rows: agg } = await db.query<{ symbols: number; latest: Date | string | null }>(
      `SELECT COUNT(DISTINCT symbol) AS symbols,
              MAX(ts) AS latest
         FROM market_data_daily`,
    );
    const universeCount = Number(agg[0]?.symbols ?? 0);
    const latestCandleDate = toYmd(agg[0]?.latest);

    const { rows: ready } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT symbol
           FROM market_data_daily
          GROUP BY symbol
         HAVING COUNT(*) >= ?
       ) t`,
      [minBars],
    );
    const symbolsWithEnoughBars = Number(ready[0]?.cnt ?? 0);

    const todayIst = istYmd();
    let staleSymbolCount = universeCount;
    if (latestCandleDate) {
      const age = daysBetweenIst(latestCandleDate, todayIst);
      if (age <= maxStaleDays) {
        const { rows: stale } = await db.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM (
             SELECT symbol, MAX(ts) AS mx
               FROM market_data_daily
              GROUP BY symbol
             HAVING DATEDIFF(?, DATE(MAX(ts))) > ?
           ) t`,
          [todayIst, maxStaleDays],
        );
        staleSymbolCount = Number(stale[0]?.cnt ?? 0);
      }
    }

    const reasons: string[] = [];
    if (universeCount === 0) reasons.push('empty_warehouse');
    if (!latestCandleDate) reasons.push('no_candle_dates');
    if (latestCandleDate) {
      const age = daysBetweenIst(latestCandleDate, todayIst);
      if (age > maxStaleDays) reasons.push(`latest_candle_stale_days=${age}`);
    }
    if (symbolsWithEnoughBars < minReadySymbols) {
      reasons.push(
        `insufficient_bars symbolsWithEnoughBars=${symbolsWithEnoughBars} min=${minReadySymbols}`,
      );
    }

    return {
      ok: reasons.length === 0,
      universeCount,
      symbolsWithEnoughBars,
      latestCandleDate,
      staleSymbolCount,
      minBarsRequired: minBars,
      maxStaleDays,
      indianApiBreakerState,
      reason: reasons.length ? reasons.join('; ') : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      universeCount: 0,
      symbolsWithEnoughBars: 0,
      latestCandleDate: null,
      staleSymbolCount: 0,
      minBarsRequired: minBars,
      maxStaleDays,
      indianApiBreakerState,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function assertWarehouseHealthy(report: WarehouseHealthReport): void {
  if (report.ok) return;
  throw new Error(`WAREHOUSE_NOT_READY: ${report.reason ?? 'unknown'}`);
}

export function logWarehouseHealth(report: WarehouseHealthReport): void {
  console.log(
    `[WAREHOUSE_HEALTH] ok=${report.ok ? 1 : 0} universeCount=${report.universeCount} ` +
    `symbolsWithEnoughBars=${report.symbolsWithEnoughBars} ` +
    `latestCandleDate=${report.latestCandleDate ?? 'null'} ` +
    `staleSymbolCount=${report.staleSymbolCount} ` +
    `indianApiBreakerState=${report.indianApiBreakerState}` +
    (report.reason ? ` reason=${report.reason}` : ''),
  );
}
