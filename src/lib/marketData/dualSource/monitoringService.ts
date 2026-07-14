// In-memory dual-source monitoring + per-symbol confirmation cache.

import type {
  ApprovalStatus,
  ConfirmationResult,
  ConfirmationStatus,
  DualSourceBatchResult,
  DualSourceMonitoringSnapshot,
  FeedHealthSlice,
  FeedSourceId,
  ValidationStatus,
} from './types';

const GLOBAL_KEY = '__q365_dual_source_monitor__';

interface MonitorGlobal {
  enabled: boolean;
  yahoo: FeedHealthSlice;
  kite: FeedHealthSlice;
  bySymbol: Map<string, DualSourceBatchResult>;
  lastValidationAt: number | null;
}

function emptyHealth(source: FeedSourceId): FeedHealthSlice {
  return {
    source,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    successCount: 0,
    errorCount: 0,
    avgLatencyMs: 0,
    lastLtp: null,
  };
}

function monitor(): MonitorGlobal {
  const g = globalThis as unknown as Record<string, MonitorGlobal | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      enabled: false,
      yahoo: emptyHealth('yahoo'),
      kite: emptyHealth('kite'),
      bySymbol: new Map(),
      lastValidationAt: null,
    };
  }
  return g[GLOBAL_KEY]!;
}

function rollingLatency(slice: FeedHealthSlice, latencyMs: number): void {
  const n = slice.successCount;
  slice.avgLatencyMs = n <= 1
    ? latencyMs
    : Math.round((slice.avgLatencyMs * (n - 1) + latencyMs) / n);
}

export function setDualSourceMonitoringEnabled(on: boolean): void {
  monitor().enabled = on;
}

export function recordSourceFetch(
  source: FeedSourceId,
  ok: boolean,
  latencyMs: number,
  ltp: number | null,
  error: string | null,
  now = Date.now(),
): void {
  const m = monitor();
  const slice = source === 'yahoo' ? m.yahoo : m.kite;
  if (ok) {
    slice.lastSuccessAt = now;
    slice.successCount += 1;
    slice.lastLtp = ltp;
    rollingLatency(slice, latencyMs);
  } else {
    slice.lastErrorAt = now;
    slice.lastError = error;
    slice.errorCount += 1;
  }
}

export function recordBatchResult(result: DualSourceBatchResult): void {
  const m = monitor();
  m.bySymbol.set(result.symbol, result);
  m.lastValidationAt = result.validation.validatedAt;
  // cap memory — keep latest 500 symbols
  if (m.bySymbol.size > 500) {
    const oldest = [...m.bySymbol.entries()]
      .sort((a, b) => a[1].validation.validatedAt - b[1].validation.validatedAt)[0]?.[0];
    if (oldest) m.bySymbol.delete(oldest);
  }
}

export function getConfirmationForSymbol(symbol: string): ConfirmationResult | null {
  const row = monitor().bySymbol.get(symbol.toUpperCase());
  return row?.confirmation ?? null;
}

export function getDualSourceMonitoringSnapshot(): DualSourceMonitoringSnapshot {
  const m = monitor();
  let confirmed = 0;
  let pending = 0;
  let mismatch = 0;
  let single = 0;
  let noData = 0;

  const recent: DualSourceMonitoringSnapshot['recent'] = [];
  for (const row of m.bySymbol.values()) {
    switch (row.validation.status) {
      case 'confirmed': confirmed++; break;
      case 'pending_validation': pending++; break;
      case 'data_mismatch': mismatch++; break;
      case 'single_source': single++; break;
      default: noData++;
    }
    recent.push({
      symbol: row.symbol,
      validationStatus: row.validation.status,
      approvalStatus: row.approval.status,
      confirmationStatus: row.confirmation.status,
      confidenceScore: row.approval.confidenceScore,
      yahooLtp: row.validation.yahoo?.ltp ?? null,
      kiteLtp: row.validation.kite?.ltp ?? null,
      priceDiffBps: row.validation.metrics.priceDiffBps,
      validatedAt: row.validation.validatedAt,
    });
  }

  recent.sort((a, b) => b.validatedAt - a.validatedAt);

  return {
    enabled: m.enabled,
    yahoo: { ...m.yahoo },
    kite: { ...m.kite },
    lastValidationAt: m.lastValidationAt,
    symbolsTracked: m.bySymbol.size,
    confirmedCount: confirmed,
    pendingCount: pending,
    mismatchCount: mismatch,
    singleSourceCount: single,
    noDataCount: noData,
    recent: recent.slice(0, 50),
  };
}

/** Test helper */
export function _resetDualSourceMonitorForTests(): void {
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
}
