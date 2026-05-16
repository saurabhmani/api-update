// ════════════════════════════════════════════════════════════════
//  Manipulation Scanner — Quantorus365
//
//  Runs the surveillance layer against the Phase 1 universe (or a
//  caller-supplied list) and persists the results into the four
//  manipulation tables.
//
//  What this worker does:
//    1. ensureManipulationEngineTables()          — idempotent schema
//    2. for every symbol in the universe:
//         loadDailyBars() → scanSymbol() → saveSnapshot()
//       which transitively writes:
//         q365_manipulation_snapshots
//         q365_manipulation_events         (via saveSnapshot)
//         q365_manipulation_detector_results (via saveSnapshot)
//    3. retroactive penalty backfill — for every snapshot ≥ elevated,
//       find recent q365_signals for that symbol and write one row
//       into q365_manipulation_penalties per (signal, snapshot) pair.
//       Idempotent — skips pairs that already have a penalty row.
//
//  Why the penalty step is here rather than in scanSymbol: penalties
//  are normally applied at signal-generation time by the Phase 1
//  pipeline (generatePhase1Signals.ts calls applyManipulationPenalty).
//  When the scanner runs against a live DB with pre-existing signals,
//  those signals were generated BEFORE their symbols had a snapshot,
//  so the normal hook path never ran for them. This step retroactively
//  seals that audit gap.
//
//  Triggering:
//    - Manual: `npx tsx src/lib/workers/manipulationScanner.ts`
//    - Cron:   `import { runManipulationScan } ...` and schedule once
//              per day after EOD candles land (e.g. 18:30 IST).
//    - API:    wire runManipulationScan() behind an admin POST.
// ════════════════════════════════════════════════════════════════

// This module is a PURE LIBRARY — no top-level side effects. Both the
// Next.js API route (`/api/manipulation/run`) and the standalone CLI
// (`manipulationScannerCli.ts`) import from here. The CLI wrapper is
// responsible for bootstrapping `.env.local` + tsconfig path aliases
// before this file's `@/...` imports resolve. Under Next.js, env and
// path resolution are handled by the Next runtime — any bootstrap code
// at this level would double-register during `next build` page-data
// collection and break the build.

import { db } from '@/lib/db';
import {
  ensureManipulationEngineTables,
  scanSymbol,
  saveSnapshot,
  type ScanOptions,
} from '@/lib/manipulation-engine';
import { loadDailyBars } from '@/lib/manipulation-engine/data/candleLoader';
import type {
  ManipulationSnapshot,
  SuspicionBand,
  ManipulationPenaltyRecord,
} from '@/lib/manipulation-engine/types';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine';
import { decideActions } from '@/lib/manipulation-engine/actions/actionRegistry';

// ════════════════════════════════════════════════════════════════
//  TUNABLES
// ════════════════════════════════════════════════════════════════

const BAR_LOOKBACK              = 60;   // trailing days per symbol
const DETECTOR_WINDOW           = 30;   // bars handed to each detector
const MIN_BARS_TO_SCAN          = 22;   // below this, features are unstable
const PENALTY_LOOKBACK_DAYS     = 30;   // consider signals this recent for retroactive penalties
const PENALTY_BANDS_TO_APPLY    : SuspicionBand[] = ['elevated', 'high', 'severe'];

// ════════════════════════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════════════════════════

export interface ScanRunOptions {
  /** Override the default Phase 1 universe. */
  universe?: string[];
  /** Pass through to scanSymbol (detectorWindow, advanced bar inputs, ...). */
  scanOptions?: ScanOptions;
  /** If true, skip the retroactive penalty backfill step. */
  skipPenalties?: boolean;
  /** Cap symbols to process. Useful for ad-hoc testing. */
  limit?: number;
}

export interface ScanRunResult {
  scanned:            number;
  snapshotsPersisted: number;
  skippedInsufficient:number;
  failed:             number;
  bandCounts:         Record<SuspicionBand, number>;
  penaltiesWritten:   number;
  durationMs:         number;
}

// ════════════════════════════════════════════════════════════════
//  PENALTY BACKFILL
// ════════════════════════════════════════════════════════════════

interface PenaltyBackfillCounts {
  written:  number;
  skipped:  number;
  failed:   number;
}

async function backfillPenaltiesForSnapshot(
  snapshot: ManipulationSnapshot,
  snapshotId: number,
): Promise<PenaltyBackfillCounts> {
  const counts: PenaltyBackfillCounts = { written: 0, skipped: 0, failed: 0 };
  if (!PENALTY_BANDS_TO_APPLY.includes(snapshot.suspicionBand)) return counts;

  // Policy lookup — same source the live pipeline uses, so retroactive
  // penalties are byte-identical to what applyManipulationPenalty would
  // have written had the scanner run before the signal was generated.
  const decision = decideActions(snapshot.suspicionBand);
  if (decision.confidenceDelta === 0 && decision.riskDelta === 0 && !decision.suppress) {
    return counts;
  }

  const warningPrefix = snapshot.suspicionBand.charAt(0).toUpperCase() + snapshot.suspicionBand.slice(1);
  const reason = `${warningPrefix} manipulation suspicion (${snapshot.manipulationScore}/100)${decision.suppress ? ' — signal suppressed' : ''}`;

  // Find candidate signals: same symbol, generated within the penalty
  // lookback, not already penalised against THIS snapshot. Both sides
  // of the NOT EXISTS comparison are coerced to UNSIGNED — q365_signals.id
  // is INT and q365_manipulation_penalties.signal_id is VARCHAR with a
  // different collation, so a direct `=` trips ER_CANT_AGGREGATE_2COLLATIONS
  // on some MySQL versions.
  const { rows: sigRows } = await db.query(
    `SELECT s.id
       FROM q365_signals s
      WHERE s.symbol = ?
        AND s.generated_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND NOT EXISTS (
          SELECT 1 FROM q365_manipulation_penalties mp
           WHERE CAST(mp.signal_id AS UNSIGNED) = s.id
             AND mp.snapshot_id = ?
        )`,
    [snapshot.symbol, PENALTY_LOOKBACK_DAYS, snapshotId],
  );

  for (const r of sigRows as any[]) {
    const record: ManipulationPenaltyRecord = {
      signalId:          String(r.id),
      snapshotId,
      confidencePenalty: decision.confidenceDelta,
      riskPenalty:       decision.riskDelta,
      rejectionFlag:     decision.suppress,
      reason,
    };
    try {
      await db.query(
        `INSERT INTO q365_manipulation_penalties
          (signal_id, snapshot_id, confidence_penalty, risk_penalty, rejection_flag, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          record.signalId,
          record.snapshotId,
          record.confidencePenalty,
          record.riskPenalty,
          record.rejectionFlag ? 1 : 0,
          record.reason,
        ],
      );
      counts.written++;
    } catch (err) {
      counts.failed++;
      console.error(
        `[manipulation-scanner] penalty write failed for signal_id=${r.id} snapshot_id=${snapshotId}:`,
        (err as Error).message,
      );
    }
  }

  if (sigRows.length === 0) counts.skipped = 1;
  return counts;
}

// ════════════════════════════════════════════════════════════════
//  MAIN ENTRYPOINT
// ════════════════════════════════════════════════════════════════

export async function runManipulationScan(
  options: ScanRunOptions = {},
): Promise<ScanRunResult> {
  const start = Date.now();
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Manipulation Scanner — ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════\n');

  await ensureManipulationEngineTables();

  const universe = (options.universe ?? DEFAULT_PHASE1_CONFIG.universe).slice(
    0,
    options.limit ?? Infinity,
  );
  console.log(`[MANIPULATION] scan started — ${universe.length} symbols`);

  const result: ScanRunResult = {
    scanned:             0,
    snapshotsPersisted:  0,
    skippedInsufficient: 0,
    failed:              0,
    bandCounts:          { low: 0, watch: 0, elevated: 0, high: 0, severe: 0 },
    penaltiesWritten:    0,
    durationMs:          0,
  };

  const elevatedSnapshots: Array<{ snapshot: ManipulationSnapshot; id: number }> = [];

  for (const symbol of universe) {
    result.scanned++;
    try {
      const bars = await loadDailyBars(symbol, { lookback: BAR_LOOKBACK });
      if (bars.length < MIN_BARS_TO_SCAN) {
        result.skippedInsufficient++;
        continue;
      }

      const snapshot = scanSymbol(symbol, bars, { symbol }, {
        detectorWindow: DETECTOR_WINDOW,
        ...(options.scanOptions ?? {}),
      });
      if (!snapshot) {
        result.skippedInsufficient++;
        continue;
      }

      // ── Phase 5+6: Cross-reference with news hype + burst detection ──
      // News cannot REDUCE manipulation score — penalty only.
      // Phase 6 additions:
      //   - Coordinated narrative burst detection (many similar items in short window)
      //   - Source class awareness (social vs official)
      //   - Structured manipulation flags
      const manipFlags: string[] = [];
      try {
        const { rows: newsRows } = await db.query<any>(
          `SELECT MAX(ns.manipulation_risk_boost) AS max_manip_boost,
                  AVG(ns.trust_score) AS avg_trust,
                  AVG(ns.sentiment_magnitude) AS avg_magnitude,
                  COUNT(*) AS event_count,
                  COUNT(DISTINCT ne.title) AS distinct_titles,
                  SUM(CASE WHEN ns.trust_score < 40 THEN 1 ELSE 0 END) AS low_trust_count,
                  SUM(CASE WHEN ns.sentiment_score > 0 THEN 1 ELSE 0 END) AS bullish_count,
                  MIN(ne.published_at) AS first_published,
                  MAX(ne.published_at) AS last_published
             FROM q365_news_scores ns
             JOIN q365_news_events ne ON ne.id = ns.news_event_id
            WHERE ns.symbol = ?
              AND ne.published_at >= DATE_SUB(?, INTERVAL 48 HOUR)
              AND ne.published_at <= ?`,
          [symbol, snapshot.snapshotDate, snapshot.snapshotDate],
        );
        const newsRow = newsRows[0];
        if (newsRow && Number(newsRow.event_count) > 0) {
          const eventCount = Number(newsRow.event_count);
          const maxManipBoost = Number(newsRow.max_manip_boost ?? 0);
          const avgTrust = Number(newsRow.avg_trust ?? 50);
          const avgMagnitude = Number(newsRow.avg_magnitude ?? 0);
          const distinctTitles = Number(newsRow.distinct_titles ?? 0);
          const lowTrustCount = Number(newsRow.low_trust_count ?? 0);
          const bullishCount = Number(newsRow.bullish_count ?? 0);

          // ── Original hype detection ────────────────────────────
          let newsHypeBoost = 0;
          if (maxManipBoost >= 25 && avgTrust < 45) {
            newsHypeBoost = Math.min(15, Math.round(maxManipBoost * 0.3));
            manipFlags.push('possible_hype_only_move');
          } else if (maxManipBoost >= 15 && avgMagnitude >= 60) {
            newsHypeBoost = Math.min(10, Math.round(maxManipBoost * 0.2));
          }

          // ── Coordinated narrative burst detection ──────────────
          // Many similar headlines in a short window with low originality
          const titleRepetitionRatio = eventCount > 0 ? distinctTitles / eventCount : 1;
          if (eventCount >= 5 && titleRepetitionRatio < 0.5) {
            // High repetition: many events, few unique titles
            newsHypeBoost += Math.min(8, Math.round((1 - titleRepetitionRatio) * 15));
            manipFlags.push('narrative_burst_without_official_confirmation');
          }

          // ── Social-heavy source concentration ──────────────────
          const lowTrustRatio = eventCount > 0 ? lowTrustCount / eventCount : 0;
          if (lowTrustRatio > 0.6 && eventCount >= 3) {
            newsHypeBoost += Math.min(5, Math.round(lowTrustRatio * 8));
            manipFlags.push('suspicious_sentiment_volume_divergence');
          }

          // ── Bullish sentiment spike without official backing ───
          const bullishRatio = eventCount > 0 ? bullishCount / eventCount : 0;
          if (bullishRatio > 0.8 && avgTrust < 50 && eventCount >= 4) {
            newsHypeBoost += 3;
            manipFlags.push('possible_hype_only_move');
          }

          // ── Sentiment spike detection ─────────────────────────
          // Extreme sentiment magnitude with low trust = suspicious
          if (avgMagnitude >= 70 && avgTrust < 45) {
            newsHypeBoost += Math.min(6, Math.round((avgMagnitude - 50) * 0.15));
            manipFlags.push('extreme_sentiment_low_trust');
          }

          // ── Time-compressed burst detection ───────────────────
          // Many events published within a very short window
          const firstPub = newsRow.first_published ? new Date(newsRow.first_published).getTime() : 0;
          const lastPub = newsRow.last_published ? new Date(newsRow.last_published).getTime() : 0;
          if (firstPub > 0 && lastPub > 0) {
            const burstWindowHours = (lastPub - firstPub) / (1000 * 60 * 60);
            if (eventCount >= 6 && burstWindowHours < 2) {
              newsHypeBoost += Math.min(7, eventCount - 4);
              manipFlags.push('time_compressed_burst');
            }
          }

          if (newsHypeBoost > 0) {
            snapshot.manipulationScore = Math.min(100, snapshot.manipulationScore + newsHypeBoost);
            // Re-derive band from boosted score
            if (snapshot.manipulationScore >= 80) snapshot.suspicionBand = 'severe';
            else if (snapshot.manipulationScore >= 60) snapshot.suspicionBand = 'high';
            else if (snapshot.manipulationScore >= 40) snapshot.suspicionBand = 'elevated';
            else if (snapshot.manipulationScore >= 20) snapshot.suspicionBand = 'watch';
            const uniqueFlags = [...new Set(manipFlags)];
            snapshot.explanation = `${snapshot.explanation} [News hype boost: +${newsHypeBoost} (manip_boost=${maxManipBoost}, trust=${Math.round(avgTrust)}, flags=${uniqueFlags.join(',')})]`;
          }
        }
      } catch {
        // News tables may not exist — skip silently
      }

      const snapshotId = await saveSnapshot(snapshot);
      result.snapshotsPersisted++;
      result.bandCounts[snapshot.suspicionBand]++;
      console.log(`[MANIPULATION] snapshot saved for ${symbol} (id=${snapshotId}, band=${snapshot.suspicionBand}, score=${snapshot.manipulationScore})`);

      if (PENALTY_BANDS_TO_APPLY.includes(snapshot.suspicionBand) && snapshotId) {
        elevatedSnapshots.push({ snapshot, id: snapshotId });
      }
    } catch (err) {
      result.failed++;
      console.error(`[manipulation-scanner] ${symbol} failed:`, (err as Error).message);
    }
  }

  console.log(
    `  snapshots: persisted=${result.snapshotsPersisted}  ` +
    `insufficient=${result.skippedInsufficient}  failed=${result.failed}`,
  );
  console.log(
    `  band counts: low=${result.bandCounts.low} watch=${result.bandCounts.watch} ` +
    `elevated=${result.bandCounts.elevated} high=${result.bandCounts.high} severe=${result.bandCounts.severe}`,
  );

  // ── Retroactive penalty backfill ───────────────────────────
  if (!options.skipPenalties && elevatedSnapshots.length > 0) {
    console.log(`\n▶ retroactive penalty backfill for ${elevatedSnapshots.length} elevated+ snapshots`);
    for (const { snapshot, id } of elevatedSnapshots) {
      const counts = await backfillPenaltiesForSnapshot(snapshot, id);
      result.penaltiesWritten += counts.written;
    }
    console.log(`  penalties written: ${result.penaltiesWritten}`);
  }

  result.durationMs = Date.now() - start;
  console.log(`\n  duration: ${result.durationMs}ms\n`);
  return result;
}

// CLI entry lives in `manipulationScannerCli.ts` — see that file for
// the PM2 / `npm run manipulation-scan` invocation path.
