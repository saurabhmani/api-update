/**
 * scripts/diagnoseLiveVsLocal.ts
 *
 * Compares two deployments of /signals (typically localhost vs your
 * live VPS) by logging into each and diffing the API responses.
 *
 * What it tells you, in order of severity:
 *   1. Are they pointing at the same database?       (user-record check)
 *   2. Are they running the same code?                (code-version
 *                                                      header / response
 *                                                      shape check)
 *   3. Are their scanners producing the same batches? (latest_batch_id)
 *   4. Is the same data being filtered into the main grid?
 *      (signal symbol set + classification distribution)
 *   5. Are they serving cached vs fresh responses?    (response_generated_at,
 *                                                      cache headers)
 *
 * Usage:
 *
 *   # Interactive: pass URLs + creds via env
 *   LOCAL_URL=http://localhost:3000 \
 *   LIVE_URL=https://quantorus.in \
 *   LOCAL_EMAIL=john@quantorus365.in    LOCAL_PASS='John@12345' \
 *   LIVE_EMAIL=john@quantorus365.in     LIVE_PASS='your-live-pass' \
 *     npx tsx scripts/diagnoseLiveVsLocal.ts
 *
 *   # Same email/password on both? Use the *_EMAIL/*_PASS still — the
 *   # script never assumes shared creds, since the whole point is that
 *   # different DBs have different user records.
 *
 * Output is a side-by-side report with explicit "DIVERGENCE:" lines.
 * Exit code 0 if responses are identical, 1 otherwise.
 */

interface EnvProbe {
  name:          string;
  base:          string;
  authStatus?:   number;
  authError?:    string;
  cookie?:       string;
  signals?:      SignalsProbe;
  freshness?:    FreshnessProbe;
  fetchError?:   string;
}

interface SignalsProbe {
  http_status:           number;
  response_generated_at: string | null;
  validation_status:     string | null;
  source:                string | null;
  data_source:           string | null;
  latest_batch_id:       string | null;
  last_pipeline_run:     string | null;
  main_signals_count:    number | null;
  buy_count:             number | null;
  sell_count:            number | null;
  emerging_count:        number | null;
  symbols:               string[];
  classifications:       Record<string, number>;
  cache_control:         string | null;
}

interface FreshnessProbe {
  http_status:            number;
  active_confirmed_count: number | null;
  latest_confirmed_at:    string | null;
  latest_batch_id:        string | null;
  total_stored_signals:   number | null;
  candle_latest_ts:       string | null;
  tracker_total:          number | null;
}

function need(varName: string): string {
  const v = process.env[varName];
  if (!v) {
    console.error(`Missing env var: ${varName}`);
    process.exit(2);
  }
  return v;
}

function pickCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  // We only care about q200_session=<value>; ignore Path, HttpOnly, etc.
  const parts = setCookie.split(',');
  for (const p of parts) {
    const m = /q200_session=[^;]+/.exec(p);
    if (m) return m[0];
  }
  return null;
}

async function probeAuth(env: EnvProbe, email: string, password: string): Promise<void> {
  try {
    const res = await fetch(`${env.base}/api/auth`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'login', email, password }),
    });
    env.authStatus = res.status;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      env.authError = body.slice(0, 200);
      return;
    }
    env.cookie = pickCookie(res.headers.get('set-cookie')) ?? undefined;
  } catch (err) {
    env.authError = (err as Error).message;
  }
}

async function probeSignals(env: EnvProbe): Promise<void> {
  if (!env.cookie) return;
  try {
    const res = await fetch(`${env.base}/api/signals?action=all&limit=100`, {
      headers: { Cookie: env.cookie },
    });
    if (!res.ok) {
      env.fetchError = `signals HTTP ${res.status}`;
      return;
    }
    const j: any = await res.json();
    const signals: any[] = j.signals ?? [];
    const cls: Record<string, number> = {};
    for (const s of signals) {
      const k = String(s.classification ?? '(null)').toUpperCase();
      cls[k] = (cls[k] ?? 0) + 1;
    }
    env.signals = {
      http_status:           res.status,
      response_generated_at: j.response_generated_at ?? null,
      validation_status:     j.validation_status ?? null,
      source:                j.source ?? null,
      data_source:           j.data_source ?? null,
      latest_batch_id:       j.latest_batch_id ?? null,
      last_pipeline_run:     j.last_pipeline_run ?? null,
      main_signals_count:    j.main_signals_count ?? signals.length,
      buy_count:             j.buy_count ?? null,
      sell_count:            j.sell_count ?? null,
      emerging_count:        j.emerging_count ?? null,
      symbols:               signals.map((s: any) => String(s.tradingsymbol ?? s.symbol ?? '')).filter(Boolean),
      classifications:       cls,
      cache_control:         res.headers.get('cache-control'),
    };
  } catch (err) {
    env.fetchError = `signals: ${(err as Error).message}`;
  }
}

async function probeFreshness(env: EnvProbe): Promise<void> {
  if (!env.cookie) return;
  try {
    const res = await fetch(`${env.base}/api/signals/freshness`, {
      headers: { Cookie: env.cookie },
    });
    if (!res.ok) {
      env.freshness = {
        http_status: res.status,
        active_confirmed_count: null, latest_confirmed_at: null,
        latest_batch_id: null, total_stored_signals: null,
        candle_latest_ts: null, tracker_total: null,
      };
      return;
    }
    const j: any = await res.json();
    const f = j.freshness ?? {};
    env.freshness = {
      http_status:            res.status,
      active_confirmed_count: f.active_confirmed_count ?? null,
      latest_confirmed_at:    f.latest_confirmed_at ?? null,
      latest_batch_id:        f.latest_batch_id ?? null,
      total_stored_signals:   f.total_stored_signals ?? null,
      candle_latest_ts:       f.candle_latest_ts ?? null,
      tracker_total:          f.tracker_counts?.total ?? null,
    };
  } catch (err) {
    env.fetchError = (env.fetchError ? env.fetchError + ' | ' : '') + `freshness: ${(err as Error).message}`;
  }
}

function diffSets(a: string[], b: string[]): { onlyA: string[]; onlyB: string[]; shared: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyA: [...setA].filter((x) => !setB.has(x)),
    onlyB: [...setB].filter((x) => !setA.has(x)),
    shared: [...setA].filter((x) => setB.has(x)),
  };
}

function fmt(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function row(label: string, a: unknown, b: unknown, divergent?: boolean): void {
  const va = fmt(a).padEnd(34);
  const vb = fmt(b).padEnd(34);
  const flag = divergent === true ? '  ⚠ DIVERGENT'
             : divergent === false ? ''
             : (a === b || JSON.stringify(a) === JSON.stringify(b)) ? '' : '  ⚠ DIVERGENT';
  console.log(`  ${label.padEnd(28)} ${va}  ${vb}${flag}`);
}

async function main(): Promise<void> {
  const localUrl  = need('LOCAL_URL');
  const liveUrl   = need('LIVE_URL');
  const localEmail = need('LOCAL_EMAIL');
  const localPass  = need('LOCAL_PASS');
  const liveEmail  = need('LIVE_EMAIL');
  const livePass   = need('LIVE_PASS');

  const local: EnvProbe = { name: 'LOCAL', base: localUrl };
  const live:  EnvProbe = { name: 'LIVE',  base: liveUrl  };

  console.log(`\nDiagnose: comparing ${local.name} (${local.base}) vs ${live.name} (${live.base})`);
  console.log('='.repeat(96));

  await Promise.all([
    probeAuth(local, localEmail, localPass),
    probeAuth(live,  liveEmail,  livePass),
  ]);

  // ── 1. Auth: do the credentials work on each environment? ──
  console.log('\n[1] Authentication');
  row('login HTTP status', local.authStatus, live.authStatus);
  row('cookie set?', local.cookie ? 'yes' : 'no', live.cookie ? 'yes' : 'no');
  if (local.authError) console.log(`  LOCAL auth error: ${local.authError}`);
  if (live.authError)  console.log(`  LIVE  auth error: ${live.authError}`);

  if (local.authStatus !== live.authStatus) {
    console.log('  ⚠ DIVERGENT: same credentials, different auth result.');
    console.log('    Most likely cause: local and live point at SEPARATE user databases.');
    console.log('    Implication: if user tables differ, signal tables almost certainly differ too.');
  }

  if (!local.cookie || !live.cookie) {
    console.log('\n[!] Cannot complete signal/freshness diff — at least one auth failed.');
    console.log('    Resolve auth on the failing environment first, then re-run.');
    if (local.cookie || live.cookie) {
      // Probe at least the side that's logged in for contextual info.
      const which = local.cookie ? local : live;
      await probeSignals(which);
      await probeFreshness(which);
      console.log(`\n[Partial — only ${which.name} could be probed]`);
      console.log('  signals.latest_batch_id:    ', which.signals?.latest_batch_id);
      console.log('  signals.main_signals_count:', which.signals?.main_signals_count);
      console.log('  freshness.active_confirmed:', which.freshness?.active_confirmed_count);
    }
    process.exit(1);
  }

  // ── 2. Endpoint probes in parallel ──
  await Promise.all([
    probeSignals(local), probeSignals(live),
    probeFreshness(local), probeFreshness(live),
  ]);

  if (local.fetchError) console.log(`  LOCAL fetch error: ${local.fetchError}`);
  if (live.fetchError)  console.log(`  LIVE  fetch error: ${live.fetchError}`);

  // ── 3. /api/signals comparison ──
  if (local.signals && live.signals) {
    console.log('\n[2] /api/signals?action=all  side-by-side');
    console.log(`  ${'field'.padEnd(28)} ${'LOCAL'.padEnd(34)}  ${'LIVE'.padEnd(34)}`);
    console.log('  ' + '-'.repeat(94));
    row('http_status',           local.signals.http_status,           live.signals.http_status);
    row('response_generated_at', local.signals.response_generated_at, live.signals.response_generated_at, false);
    row('validation_status',     local.signals.validation_status,     live.signals.validation_status);
    row('source',                local.signals.source,                live.signals.source);
    row('data_source',           local.signals.data_source,           live.signals.data_source);
    row('latest_batch_id',       local.signals.latest_batch_id,       live.signals.latest_batch_id);
    row('last_pipeline_run',     local.signals.last_pipeline_run,     live.signals.last_pipeline_run);
    row('main_signals_count',    local.signals.main_signals_count,    live.signals.main_signals_count);
    row('buy_count',             local.signals.buy_count,             live.signals.buy_count);
    row('sell_count',            local.signals.sell_count,            live.signals.sell_count);
    row('emerging_count',        local.signals.emerging_count,        live.signals.emerging_count);
    row('cache_control',         local.signals.cache_control,         live.signals.cache_control, false);

    console.log('\n[3] Classification distribution in main grid');
    const allKeys = new Set([
      ...Object.keys(local.signals.classifications),
      ...Object.keys(live.signals.classifications),
    ]);
    for (const k of [...allKeys].sort()) {
      row(`  ${k}`,
          local.signals.classifications[k] ?? 0,
          live.signals.classifications[k] ?? 0);
    }

    // Symbol-set diff
    console.log('\n[4] Main-grid symbol set');
    const d = diffSets(local.signals.symbols, live.signals.symbols);
    console.log(`  shared:    ${d.shared.length} symbol(s)`);
    console.log(`  only LOCAL: ${d.onlyA.length} symbol(s)${d.onlyA.length ? ' → ' + d.onlyA.slice(0, 12).join(', ') + (d.onlyA.length > 12 ? ', …' : '') : ''}`);
    console.log(`  only LIVE:  ${d.onlyB.length} symbol(s)${d.onlyB.length ? ' → ' + d.onlyB.slice(0, 12).join(', ') + (d.onlyB.length > 12 ? ', …' : '') : ''}`);
  }

  // ── 4. /api/signals/freshness comparison ──
  if (local.freshness && live.freshness) {
    console.log('\n[5] /api/signals/freshness  side-by-side');
    console.log(`  ${'field'.padEnd(28)} ${'LOCAL'.padEnd(34)}  ${'LIVE'.padEnd(34)}`);
    console.log('  ' + '-'.repeat(94));
    row('http_status',            local.freshness.http_status,            live.freshness.http_status);
    row('active_confirmed_count', local.freshness.active_confirmed_count, live.freshness.active_confirmed_count);
    row('latest_confirmed_at',    local.freshness.latest_confirmed_at,    live.freshness.latest_confirmed_at);
    row('latest_batch_id',        local.freshness.latest_batch_id,        live.freshness.latest_batch_id);
    row('total_stored_signals',   local.freshness.total_stored_signals,   live.freshness.total_stored_signals);
    row('candle_latest_ts',       local.freshness.candle_latest_ts,       live.freshness.candle_latest_ts);
    row('tracker_total',          local.freshness.tracker_total,          live.freshness.tracker_total);
  }

  // ── 5. Verdict ──
  console.log('\n[6] Verdict');
  const checks: Array<{ label: string; same: boolean; hint?: string }> = [];
  if (local.authStatus != null && live.authStatus != null) {
    checks.push({
      label: 'same user database',
      same:  local.authStatus === live.authStatus,
      hint:  'auth result differs → user tables are not shared',
    });
  }
  if (local.signals && live.signals) {
    checks.push({
      label: 'same scanner batch',
      same:  local.signals.latest_batch_id === live.signals.latest_batch_id,
      hint:  'latest_batch_id differs → independent scanners running on each side',
    });
    checks.push({
      label: 'same row count',
      same:  local.signals.main_signals_count === live.signals.main_signals_count,
      hint:  'main_signals_count differs → either filter mismatch or different upstream pool',
    });
    const d = diffSets(local.signals.symbols, live.signals.symbols);
    checks.push({
      label: 'identical symbol set',
      same:  d.onlyA.length === 0 && d.onlyB.length === 0,
      hint:  'symbol set differs → the two grids are not the same data',
    });
  }
  if (local.freshness && live.freshness) {
    checks.push({
      label: 'same active confirmed count',
      same:  local.freshness.active_confirmed_count === live.freshness.active_confirmed_count,
      hint:  'active_confirmed_count differs → confirmed-snapshot tables are not shared',
    });
    checks.push({
      label: 'same total stored signals',
      same:  local.freshness.total_stored_signals === live.freshness.total_stored_signals,
      hint:  'total_stored_signals differs → q365_signals tables are not shared',
    });
  }

  for (const c of checks) {
    const flag = c.same ? '✓ SAME' : '✗ DIFFERS';
    console.log(`  ${flag.padEnd(11)} ${c.label}${c.same ? '' : '   →  ' + c.hint}`);
  }

  const anyDiff = checks.some((c) => !c.same);
  if (!anyDiff) {
    console.log('\n  No divergence detected — local and live are returning identical state.');
    process.exit(0);
  }

  console.log('\n  Most likely root cause:');
  if (checks.find((c) => c.label === 'same user database')?.same === false) {
    console.log('  → Two SEPARATE databases (different user tables prove it).');
    console.log('    Each environment runs its own engine + scheduler against its own DB.');
    console.log('    They will always diverge unless you point both at one DB or set up replication.');
  } else if (checks.find((c) => c.label === 'same scanner batch')?.same === false) {
    console.log('  → Same DB, but two writers competing.');
    console.log('    Disable the scheduler on the secondary process:');
    console.log('      Q365_INPROC_SCHEDULER=0 Q365_INPROC_REGEN=0 npm run start');
  } else {
    console.log('  → Code or filter mismatch between the two environments.');
    console.log('    Check git rev-parse HEAD on both, plus relevant env vars (V2.10 floors,');
    console.log('    Q365_INPROC_REGEN, SIGNALS_TARGET_CAP, etc.).');
  }

  process.exit(1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
