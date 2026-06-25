import './loadEnv';
import { resolveManipulationFreshnessStatus } from '../lib/manipulation-engine/manipulationSignalRisk';

function check(name: string, passed: boolean) {
  if (!passed) {
    console.error(`✗ ${name}`);
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

const stale = resolveManipulationFreshnessStatus({
  latestEventDate: '2026-06-23',
  latestCandleDate: '2026-06-25',
  latestScanAt: '2026-06-23T13:41:09.000Z',
  snapshotCount30d: 478,
});
check('scan predates candle → STALE', stale.isStale && stale.status === 'STALE');

const fresh = resolveManipulationFreshnessStatus({
  latestEventDate: '2026-06-25',
  latestCandleDate: '2026-06-25',
  latestScanAt: '2026-06-25T13:41:09.000Z',
  snapshotCount30d: 478,
});
check('scan matches candle → FRESH', fresh.status === 'FRESH' && !fresh.isStale);

console.log('\nManipulation freshness tests passed.\n');
