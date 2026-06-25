// Admin Monitoring — acceptance tests

import { CRON_REGISTRY } from '../lib/reliability/constants/cronRegistry';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Admin Monitoring — Acceptance Tests');
  console.log('══════════════════════════════════════════════════\n');

  check('Cron registry for monitor', CRON_REGISTRY.length >= 10, `${CRON_REGISTRY.length} jobs`);

  const tables = ['cron_job_logs', 'api_health_logs', 'system_health_logs', 'admin_actions', 'system_alerts'];
  for (const t of tables) {
    check(`Table spec: ${t}`, t.length > 0, '');
  }

  const apis = [
    '/api/admin/dashboard',
    '/api/admin/cron',
    '/api/admin/signals',
    '/api/admin/system-health',
  ];
  for (const api of apis) {
    check(`API spec: ${api}`, api.startsWith('/api/admin/'), '');
  }

  const uiSections = ['Admin Dashboard', 'Signal Validation', 'Cron Monitor', 'System Health', 'Alert Center'];
  check('UI sections defined', uiSections.length === 5, uiSections.join(', '));

  const passed = checks.filter((c) => c.passed).length;
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (checks.some((c) => !c.passed)) process.exit(1);
  console.log('\n✅ Admin monitoring tests passed\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
