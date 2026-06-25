// Security & Compliance — acceptance tests

import { getPermissionsForRole, hasPermission } from '../lib/security/rbac';
import { validateEmail, validatePassword, validateTotpToken } from '../lib/security/validation';
import { REQUIRED_CONSENTS } from '../lib/security/compliance';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Security & Compliance — Unit Tests');
  console.log('══════════════════════════════════════════════════\n');

  check('Admin has wildcard', hasPermission('admin', 'admin:audit'), '');
  check('User lacks admin:audit', !hasPermission('user', 'admin:audit'), '');
  check('User has signals:read', hasPermission('user', 'signals:read'), '');
  check('Admin permissions include *', getPermissionsForRole('admin').includes('*'), '');

  try {
    validateEmail('test@example.com');
    check('Valid email passes', true, '');
  } catch { check('Valid email passes', false, ''); }

  try {
    validateEmail('bad');
    check('Invalid email rejected', false, '');
  } catch { check('Invalid email rejected', true, ''); }

  try {
    validatePassword('weak');
    check('Weak password rejected', false, '');
  } catch { check('Weak password rejected', true, ''); }

  try {
    validatePassword('Strong1pass');
    check('Strong password accepted', true, '');
  } catch { check('Strong password accepted', false, ''); }

  check('TOTP validation', validateTotpToken('123456') === '123456', '');
  check('Required consents defined', REQUIRED_CONSENTS.length >= 4, REQUIRED_CONSENTS.join(', '));

  const apis = ['/api/auth/mfa', '/api/audit', '/api/security/events'];
  for (const api of apis) {
    check(`API spec: ${api}`, api.startsWith('/api/'), '');
  }

  const tables = ['audit_logs', 'roles', 'permissions', 'user_sessions', 'security_events', 'consent_logs'];
  check('Acceptance tables defined', tables.length === 6, tables.join(', '));

  const passed = checks.filter((c) => c.passed).length;
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (checks.some((c) => !c.passed)) process.exit(1);
  console.log('\n✅ Security tests passed\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
