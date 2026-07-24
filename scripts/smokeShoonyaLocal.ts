/**
 * Local Shoonya smoke test (no browser).
 * Usage: npx tsx scripts/smokeShoonyaLocal.ts
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const results: Array<{ step: string; ok: boolean; detail: string }> = [];

  const {
    getShoonyaConfig,
    resolveShoonyaUid,
    generateShoonyaChecksum,
    exchangeShoonyaAuthorizationCode,
    ShoonyaExchangeError,
  } = await import('../src/lib/broker/oauth/shoonya');

  const cfg = getShoonyaConfig();
  const derived = resolveShoonyaUid(cfg.clientId, process.env.SHOONYA_UID);
  const uidOk = cfg.uid === 'FN213349' || (cfg.uid !== cfg.clientId && !cfg.uid.endsWith('_U'));
  results.push({
    step: 'config',
    ok: uidOk && cfg.redirectUrl.includes('localhost'),
    detail: `clientId=${cfg.clientId} uid=${cfg.uid} derived=${derived} redirect=${cfg.redirectUrl}`,
  });

  const {
    createBrokerAuthTransaction,
    consumeBrokerAuthTransaction,
  } = await import('../src/lib/broker/connections/authTransactions');

  const userId = 7;
  await createBrokerAuthTransaction({ userId, broker: 'shoonya', state: null });
  const tx = await consumeBrokerAuthTransaction({ userId, broker: 'shoonya', state: null });
  results.push({
    step: 'auth_transaction_utc',
    ok: Boolean(tx?.id),
    detail: tx ? `claimed ${tx.id}` : 'consume returned null (UTC expiry bug or DB issue)',
  });

  // Live GenAcsTok with a disposable code — proves network + payload shape + IP whitelist.
  try {
    await exchangeShoonyaAuthorizationCode('SMOKE_INVALID_CODE', cfg);
    results.push({
      step: 'genacstok_live',
      ok: false,
      detail: 'unexpected success with fake code',
    });
  } catch (err) {
    const ex = err instanceof ShoonyaExchangeError ? err : null;
    const msg = ex?.brokerMessage || (err instanceof Error ? err.message : String(err));
    const ipBlocked = /whitelist|ip/i.test(msg);
    const rejected = /verifier|invalid|not_ok|reject|missing access/i.test(msg)
      || ex?.status === 401
      || ex?.status === 400;
    results.push({
      step: 'genacstok_live',
      ok: !ipBlocked && (rejected || Boolean(ex)),
      detail: ipBlocked
        ? `IP whitelist blocked: ${msg}`
        : `broker responded (expected reject): status=${ex?.status ?? 'n/a'} msg=${msg}`,
    });
  }

  // Checksum sanity
  const sum = generateShoonyaChecksum(cfg.clientId, cfg.secretCode, 'SMOKE');
  results.push({
    step: 'checksum',
    ok: /^[a-f0-9]{64}$/.test(sum),
    detail: `sha256 length=${sum.length}`,
  });

  // HTTP: unauthenticated connect must be 401
  const unauth = await fetch(`${base}/api/brokers/shoonya/connect`, { redirect: 'manual' });
  results.push({
    step: 'connect_unauth',
    ok: unauth.status === 401,
    detail: `status=${unauth.status}`,
  });

  // Mint session and hit connect
  const { createSession } = await import('../src/services/auth');
  const token = await createSession(userId, 'smoke-shoonya', '127.0.0.1');
  const connect = await fetch(`${base}/api/brokers/shoonya/connect`, {
    redirect: 'manual',
    headers: { Cookie: `q200_session=${token}` },
  });
  const location = connect.headers.get('location') || '';
  const connectOk =
    connect.status === 302
    && location.includes('trade.shoonya.com')
    && location.includes(`client_id=${encodeURIComponent(cfg.clientId)}`);
  results.push({
    step: 'connect_auth_redirect',
    ok: connectOk,
    detail: `status=${connect.status} location=${location.slice(0, 120)}`,
  });

  // CSP must not force https on localhost responses
  const health = await fetch(`${base}/api/health`);
  const csp = health.headers.get('content-security-policy') || '';
  results.push({
    step: 'csp_no_https_upgrade',
    ok: !csp.includes('upgrade-insecure-requests'),
    detail: csp.includes('upgrade-insecure-requests')
      ? 'CSP still upgrades to https (breaks local OAuth)'
      : 'ok — no upgrade-insecure-requests',
  });

  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) failed += 1;
    console.log(`${mark}  ${r.step}: ${r.detail}`);
  }
  console.log(failed === 0 ? '\nShoonya local smoke: ALL PASSED' : `\nShoonya local smoke: ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke failed', err instanceof Error ? err.message : err);
  process.exit(1);
});
