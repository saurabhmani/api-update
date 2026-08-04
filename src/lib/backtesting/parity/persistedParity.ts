import crypto from 'node:crypto';

export const PERSISTED_PARITY_TABLES = ['backtest_runs','backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','calibration_snapshots','backtest_equity_curve','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary'] as const;
export const OPERATIONAL_PARITY_FIELDS = new Set([
  'id','run_id','backtest_id','processor_id','processor_type','ownership_epoch','worker_instance_id','claimed_at','heartbeat_at','lease_expires_at',
  'processing_started_at','processing_completed_at','correlation_id','worker_version','attempt_count','cancellation_requested_at','updated_at',
  'created_at','computed_at','evaluated_at','started_at','completed_at','duration_ms','total_runtime_ms','memory_rss_mb','memory_heap_mb',
  'signals_per_sec','trades_per_sec','ms_per_trading_day','preload_ms','simulation_ms','avg_ms_per_symbol','max_ms_per_symbol',
]);
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([key]) => !OPERATIONAL_PARITY_FIELDS.has(key)).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));
  return value;
};
export const parityHash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function comparePersistedResults(monolith: Record<string,unknown>, worker: Record<string,unknown>) {
  const mismatches: { table:string; monolithHash:string; workerHash:string }[] = [];
  for (const table of PERSISTED_PARITY_TABLES) {
    const monolithHash = parityHash(monolith[table] ?? []); const workerHash = parityHash(worker[table] ?? []);
    if (monolithHash !== workerHash) mismatches.push({ table,monolithHash,workerHash });
  }
  return { verdict: mismatches.length ? 'mismatch' as const : 'equivalent' as const, comparedTables:[...PERSISTED_PARITY_TABLES], normalization:[...OPERATIONAL_PARITY_FIELDS].sort(), mismatches };
}
