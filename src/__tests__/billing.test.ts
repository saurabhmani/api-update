import './loadEnv';
// SaaS Billing Platform — unit tests

import { PLAN_CATALOG, canUpgrade, normalizePlan, planRank, creditLabel } from '../lib/billing/constants/plans';
import { checkPremiumAccess } from '../lib/billing/services/premiumAccess';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  SaaS Billing Platform — Unit Tests');
  console.log('══════════════════════════════════════════════════\n');

  check('Four plans defined', Object.keys(PLAN_CATALOG).length === 4, Object.keys(PLAN_CATALOG).join(','));
  check('Free plan has credits', PLAN_CATALOG.free.credits.ai_builder > 0, '');
  check('Pro > Free credits', PLAN_CATALOG.pro.credits.backtests > PLAN_CATALOG.free.credits.backtests, '');
  check('Premium > Pro credits', PLAN_CATALOG.premium.credits.ai_builder > PLAN_CATALOG.pro.credits.ai_builder, '');
  check('Enterprise has __all features', PLAN_CATALOG.enterprise.features.includes('__all'), '');

  check('Can upgrade free→pro', canUpgrade('free', 'pro'), '');
  check('Cannot upgrade pro→free', !canUpgrade('pro', 'free'), '');
  check('Can upgrade pro→premium', canUpgrade('pro', 'premium'), '');
  check('Plan rank order', planRank('enterprise') > planRank('premium'), '');

  check('Normalize elite→premium', normalizePlan('elite') === 'premium', '');
  check('Normalize unknown→free', normalizePlan('unknown') === 'free', '');

  check('Free plan price is 0', PLAN_CATALOG.free.priceInr === 0, '');
  check('Pro plan priced', PLAN_CATALOG.pro.priceInr > 0, `₹${PLAN_CATALOG.pro.priceInr}`);
  check('Enterprise highest price', PLAN_CATALOG.enterprise.priceInr > PLAN_CATALOG.premium.priceInr, '');

  // Premium access logic (no DB)
  const enterpriseAccess = await checkPremiumAccess(0, 'trade_setups', { role: 'admin' });
  check('Admin bypasses gating', enterpriseAccess.allowed, '');

  check('Credit label helper', creditLabel('backtests') === 'Backtests', '');

  const passed = checks.filter((c) => c.passed).length;
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (checks.some((c) => !c.passed)) process.exit(1);
  console.log('\n✅ Billing tests passed\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
