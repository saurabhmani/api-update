// ════════════════════════════════════════════════════════════════
//  Data-quality dashboard counters (Phase 1 deliverable)
//
//  Rejection counts by reason × provider for ops /metrics surfaces.
// ════════════════════════════════════════════════════════════════

export interface DataQualityCounterKey {
  reason:   string;
  provider: string;
}

const counts = new Map<string, number>();

function key(reason: string, provider: string): string {
  return `${provider}::${reason}`;
}

export function recordDataQualityRejection(reason: string, provider: string): void {
  const k = key(reason || 'UNKNOWN', provider || 'unknown');
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

export function getDataQualityRejectionCounts(): Array<{
  reason: string;
  provider: string;
  count: number;
}> {
  const out: Array<{ reason: string; provider: string; count: number }> = [];
  for (const [k, count] of counts.entries()) {
    const [provider, reason] = k.split('::');
    out.push({ provider: provider ?? 'unknown', reason: reason ?? 'UNKNOWN', count });
  }
  return out.sort((a, b) => b.count - a.count);
}

export function resetDataQualityRejectionCounts(): void {
  counts.clear();
}

/** Prometheus text exposition fragment. */
export function formatDataQualityCountersPrometheus(): string {
  const lines = [
    '# HELP q365_data_quality_rejections_total Data-quality rejections by reason and provider',
    '# TYPE q365_data_quality_rejections_total counter',
  ];
  for (const row of getDataQualityRejectionCounts()) {
    const reason = row.reason.replace(/"/g, '\\"');
    const provider = row.provider.replace(/"/g, '\\"');
    lines.push(
      `q365_data_quality_rejections_total{reason="${reason}",provider="${provider}"} ${row.count}`,
    );
  }
  return lines.join('\n') + (lines.length > 2 ? '\n' : '');
}
