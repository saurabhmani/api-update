/**
 * Verify the custom universe loads. Synchronous function — returns a
 * CustomUniverse object directly, not a Promise.
 *
 *   cd /var/www/api-update
 *   npx tsx scripts/testLoadUniverse.ts
 */
import { loadCustomUniverse } from '../src/lib/signal-engine/universe/loadCustomUniverse';

const u = loadCustomUniverse();
console.log('OK — loaded', u.nse.length, 'symbols');
console.log('   source :', u.source);
console.log('   first 5:', u.nse.slice(0, 5).join(', '));
console.log('   last 5 :', u.nse.slice(-5).join(', '));
if (u.invalid.length > 0) {
  console.log('   invalid:', u.invalid.length, '— first 3:', u.invalid.slice(0, 3));
}
