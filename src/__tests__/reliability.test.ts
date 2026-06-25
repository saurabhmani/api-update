// Platform Reliability — unit tests

import { CRON_REGISTRY } from '../lib/reliability/constants/cronRegistry';
import { getAlertChannelStatus } from '../lib/reliability/alertDelivery';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Platform Reliability — Unit Tests');
  console.log('══════════════════════════════════════════════════\n');

  check('Cron registry defined', CRON_REGISTRY.length >= 10, `${CRON_REGISTRY.length} jobs`);
  check('Market warmup in registry', CRON_REGISTRY.some((j) => j.id === 'market-warmup'), '');
  check('Learning scheduler in registry', CRON_REGISTRY.some((j) => j.id === 'learning-scheduler'), '');
  check('Manipulation scan in registry', CRON_REGISTRY.some((j) => j.id === 'manipulation-scan'), '');

  const channels = getAlertChannelStatus();
  check('Slack channel config', typeof channels.slack.enabled === 'boolean', '');
  check('Email channel config', typeof channels.email.enabled === 'boolean', '');
  check('System channel config', typeof channels.system.enabled === 'boolean', '');
  check('System alerts default on', channels.system.enabled === true, '');

  const passed = checks.filter((c) => c.passed).length;
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (checks.some((c) => !c.passed)) process.exit(1);
  console.log('\n✅ Reliability tests passed\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
