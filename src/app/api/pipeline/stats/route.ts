// ════════════════════════════════════════════════════════════════
//  GET /api/pipeline/stats
//
//  Returns a snapshot of pipeline health:
//    - Per-stage processed/errors/latency from pipelineMetrics
//    - Stream lengths (XLEN) for market_ticks + signals_stream
//    - Consumer group status (lag, pending, consumers) via XINFO
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import {
  createRedis,
  MARKET_TICKS_STREAM,
  SIGNALS_STREAM,
  STRATEGY_GROUP,
  EXECUTION_GROUP,
} from '@/lib/pipeline/streams';
import { snapshotMetrics } from '@/lib/pipeline/pipelineMetrics';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

interface GroupInfo {
  name:      string;
  consumers: number;
  pending:   number;
  lastDeliveredId: string;
}

async function getStreamStats(): Promise<{
  market_ticks:   { length: number; groups: GroupInfo[] };
  signals_stream: { length: number; groups: GroupInfo[] };
}> {
  const r = createRedis();
  try {
    const [ticksLen, signalsLen, ticksGroups, signalsGroups] = await Promise.all([
      r.xlen(MARKET_TICKS_STREAM).catch(() => 0),
      r.xlen(SIGNALS_STREAM).catch(() => 0),
      r.xinfo('GROUPS', MARKET_TICKS_STREAM).catch(() => [] as unknown[]),
      r.xinfo('GROUPS', SIGNALS_STREAM).catch(() => [] as unknown[]),
    ]);

    const parseGroups = (raw: unknown[]): GroupInfo[] => {
      const out: GroupInfo[] = [];
      for (const entry of raw) {
        if (!Array.isArray(entry)) continue;
        const kv: Record<string, unknown> = {};
        for (let i = 0; i < entry.length; i += 2) {
          kv[String(entry[i])] = entry[i + 1];
        }
        out.push({
          name:            String(kv.name ?? ''),
          consumers:       Number(kv.consumers ?? 0),
          pending:         Number(kv.pending ?? 0),
          lastDeliveredId: String(kv['last-delivered-id'] ?? ''),
        });
      }
      return out;
    };

    return {
      market_ticks:   { length: ticksLen,   groups: parseGroups(ticksGroups as unknown[]) },
      signals_stream: { length: signalsLen, groups: parseGroups(signalsGroups as unknown[]) },
    };
  } finally {
    await r.quit().catch(() => { /* noop */ });
  }
}

export async function GET(): Promise<NextResponse> {
  const metrics = snapshotMetrics();
  const streams = await getStreamStats().catch((e: Error) => ({
    market_ticks:   { length: 0, groups: [] as GroupInfo[] },
    signals_stream: { length: 0, groups: [] as GroupInfo[] },
    error: e.message,
  }));

  return NextResponse.json(
    {
      now:             new Date().toISOString(),
      metrics:         metrics.stages,
      streams,
      known_groups:    { strategy: STRATEGY_GROUP, execution: EXECUTION_GROUP },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
