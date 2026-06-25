import './loadEnv';
// Broker Integration Layer — unit tests

import { simulatedAdapter } from '../lib/broker/adapter/simulatedAdapter';
import { getBrokerAdapter, listBrokerAdapters, defaultBrokerName } from '../lib/broker/adapter/registry';
import { isRetryableError, withRetry } from '../lib/broker/sdk/retry';
import { isGlobalLiveKillSwitchActive, isLiveTradingEnabled } from '../lib/broker/killSwitch';
import { isTokenExpired } from '../lib/broker/auth/brokerAuth';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Broker Integration Layer — Unit Tests');
  console.log('══════════════════════════════════════════════════\n');

  check('Adapter registry lists brokers', listBrokerAdapters().includes('simulated'), listBrokerAdapters().join(','));
  check('Default broker resolves', typeof defaultBrokerName() === 'string', defaultBrokerName());

  const adapter = getBrokerAdapter('simulated');
  check('Get simulated adapter', adapter.name === 'simulated', '');

  const creds = { accessToken: 'test', expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const connected = await adapter.connect(creds);
  check('Simulated connect', connected.ok, '');

  const order = await adapter.placeOrder({
    symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
  }, creds);
  check('Simulated place order', order.ok && !!order.brokerOrderId, order.brokerOrderId);

  const positions = await adapter.listPositions(creds);
  check('Simulated list positions', positions.length >= 1, `count=${positions.length}`);

  const health = await adapter.healthCheck(creds);
  check('Simulated health', health.status === 'healthy', health.status);

  check('Token not expired', !isTokenExpired(new Date(Date.now() + 3600000).toISOString()), '');
  check('Token expired detection', isTokenExpired(new Date(Date.now() - 1000).toISOString()), '');

  check('Retryable NETWORK error', isRetryableError('NETWORK', 'connection reset'), '');
  check('Non-retryable error', !isRetryableError('INVALID', 'bad request'), '');

  let attempts = 0;
  await withRetry(async () => {
    attempts++;
    if (attempts < 2) throw Object.assign(new Error('NETWORK timeout'), { code: 'NETWORK' });
    return 'ok';
  }, { maxAttempts: 3, baseDelayMs: 10 });
  check('Retry succeeds on 2nd attempt', attempts === 2, `attempts=${attempts}`);

  const prev = process.env.LIVE_KILL_SWITCH;
  process.env.LIVE_KILL_SWITCH = '1';
  check('Global kill switch', isGlobalLiveKillSwitchActive(), '');
  process.env.LIVE_KILL_SWITCH = prev;

  check('Live trading mode check', typeof isLiveTradingEnabled() === 'boolean', '');

  const passed = checks.filter((c) => c.passed).length;
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (checks.some((c) => !c.passed)) process.exit(1);
  console.log('\n✅ Broker tests passed\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
