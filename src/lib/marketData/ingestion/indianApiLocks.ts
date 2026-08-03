// ════════════════════════════════════════════════════════════════
//  IndianAPI ingestion locks — prevent duplicate schedulers and
//  overlapping ingestion runs across processes / PM2 instances.
//
//  Redis SET NX EX (via cacheAcquireLock) with an in-process fallback
//  when Redis is down — the fallback still prevents overlap inside a
//  single process, which is the common deployment (one worker).
// ════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { cacheAcquireLock, cacheReleaseLock } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { recordIndianApiOverlapSkip } from '@/lib/monitor/institutionalHealth';

const log = logger.child({ component: 'indianApiLocks' });

const LOCK_KEY_PREFIX = 'indianapi:ingest:lock';

export interface IngestLockHandle {
  key: string;
  token: string;
  release: () => Promise<void>;
}

/**
 * Try to acquire the ingest lock for `tier`. Returns null when another
 * run holds it — the caller must SKIP (never queue behind the lock;
 * a skipped scheduler tick is cheaper than a pile-up).
 */
export async function acquireIngestLock(
  tier: string,
  ttlSeconds: number,
): Promise<IngestLockHandle | null> {
  const key = `${LOCK_KEY_PREFIX}:${tier}`;
  const token = randomUUID();
  const acquired = await cacheAcquireLock(key, token, ttlSeconds);
  if (!acquired) {
    // Overlap attempt — observable for ops (scheduler_overlap metric).
    recordIndianApiOverlapSkip();
    console.warn(`[INDIANAPI_INGEST] overlap_skipped tier=${tier}`);
    log.warn('ingest lock held — skipping run', { tier });
    return null;
  }
  return {
    key,
    token,
    release: async () => {
      await cacheReleaseLock(key, token);
    },
  };
}
