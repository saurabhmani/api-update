/**
* backfillTrackerCycles.ts
*
* One-time script: resets stale maturity trackers so they are eligible
* for the next maturity worker tick without waiting for another full scan cycle.
*
* What it does:
* 1. Reads all non-promoted, non-terminated trackers from q365_signal_maturity_tracker
* 2. For any tracker where last_seen_at is within the NEW stale window (600 min),
* bumps validation_cycles_passed to max(current, 2) so the next maturity
* worker tick can evaluate them for promotion.
* 3. For trackers where last_seen_at is older than 600 min, leaves them alone
* (they will reset naturally on the next scan detection).
*
* Run ONCE after updating .env:
*   npx tsx --tsconfig tsconfig.node.json -r tsconfig-paths/register scripts/backfillTrackerCycles.ts
*
* Expected output: BUMPED lines for trackers with cycles=1 seen within
* TRACKER_STALE_RESET_MIN (default 600 min). If all SKIP_STALE, run the
* signal engine once first (/api/run-signal-engine), then re-run.
*/
import { loadProjectEnv } from './loadProjectEnv';
loadProjectEnv();
import { db } from '@/lib/db';
async function main() {
    const STALE_MIN = Number(process.env.TRACKER_STALE_RESET_MIN ?? 600);
    const staleThresholdMs = STALE_MIN * 60 * 1000;
    const now = Date.now();
    console.log(`[BACKFILL] Starting tracker cycle backfill. Stale window = ${STALE_MIN} min`);
    // Read all active (non-promoted, non-terminated) trackers
    const { rows } = await db.query<{
        id: number;
        symbol: string;
        direction: string;
        validation_cycles_passed: number;
        last_seen_at: Date | string;
        stage: string;
    }>(`
SELECT id, symbol, direction, validation_cycles_passed, last_seen_at, stage
FROM q365_signal_maturity_tracker
WHERE stage IN ('candidate', 'developing', 'mature')
ORDER BY last_seen_at DESC
`);
    console.log(`[BACKFILL] Found ${rows.length} active trackers`);
    let bumped = 0;
    let skipped = 0;
    let tooStale = 0;
    for (const row of rows) {
        const lastSeenMs = new Date(row.last_seen_at).getTime();
        const ageMs = now - lastSeenMs;
        const currentCycles = Number(row.validation_cycles_passed ?? 1);
        if (ageMs > staleThresholdMs) {
            // Too stale — will reset on next detection anyway. Leave alone.
            tooStale++;
            console.log(`[BACKFILL] SKIP_STALE ${row.symbol}:${row.direction}
            age=${Math.round(ageMs / 60000)}min > ${STALE_MIN}min`);
            continue;
        }
        if (currentCycles >= 2) {
            // Already has enough cycles — skip
            skipped++;
            console.log(`[BACKFILL] SKIP_CYCLES ${row.symbol}:${row.direction}
            cycles=${currentCycles} already >= 2`);
            continue;
        }
        // Bump to 2 cycles so maturity worker can evaluate for promotion
        await db.query(`
        UPDATE q365_signal_maturity_tracker
        SET validation_cycles_passed = 2,
        updated_at = NOW()
        WHERE id = ?
        `, [row.id]);
        bumped++;
        console.log(`[BACKFILL] BUMPED ${row.symbol}:${row.direction} cycles: ${currentCycles} →2 (age=${Math.round(ageMs / 60000)}min)`);
    }
    console.log(`\n[BACKFILL] Complete. bumped=${bumped} skipped=${skipped}
    too_stale=${tooStale} total=${rows.length}`);
    console.log('[BACKFILL] Next step: restart the server — the 60s maturity worker will now evaluate these trackers for promotion.'); process.exit(0);
}
main().catch((err) => {
    console.error('[BACKFILL] Error:', err);
    process.exit(1);
});