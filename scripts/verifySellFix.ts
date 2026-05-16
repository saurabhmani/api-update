/**
 * verifySellFix — end-to-end verification for the SELL-direction bug fix
 * (generatePhase4Signals.ts:388 hardcoded action='BUY' for every strategy).
 *
 * Run:  npx tsx scripts/verifySellFix.ts
 * Flags:
 *   --fix-direction  REPAIR IN PLACE. Flip direction='BUY' → 'SELL' on
 *                    rows whose signal_type is a bearish strategy. The
 *                    trade plans on these rows are already short-semantics
 *                    (stop > entry, target < entry) — only the direction
 *                    label was written wrong by the pre-fix Phase 4 save.
 *                    Use this when you want the UI to show SELLs NOW
 *                    without waiting for a pipeline regeneration.
 *   --expire-stale   Mark mislabelled rows as expired instead of repairing.
 *                    Use when you prefer to regenerate from scratch.
 *   --verbose        Print full direction × strategy breakdown.
 *
 * Exits 0 on pass, 1 on fail. Intended to be cheap enough to run after
 * every pipeline regeneration.
 */
import fs   from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

// ── Load .env.local (same pattern as setup.ts) ───────────────────────
try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const argv = process.argv.slice(2);
const FIX_DIRECTION = argv.includes('--fix-direction');
const EXPIRE_STALE  = argv.includes('--expire-stale');
const VERBOSE       = argv.includes('--verbose');

// Bearish strategy names (must match
// src/lib/signal-engine/types/signalEngine.types.ts BEARISH_STRATEGIES).
const BEARISH = new Set([
  'bearish_breakdown',
  'overbought_reversal',
  'weak_trend_breakdown',
]);

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(color: Color, s: string): string {
  const map: Record<Color, string> = {
    red:    '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', dim:   '\x1b[2m',
  };
  return `${map[color]}${s}\x1b[0m`;
}

async function main(): Promise<number> {
  const cfg = {
    host:     process.env.MYSQL_HOST     || '127.0.0.1',
    port:     Number(process.env.MYSQL_PORT || 3306),
    user:     process.env.MYSQL_USER     || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'quantorus365',
  };

  console.log(c('dim', `\n── verifySellFix — ${cfg.host}:${cfg.port}/${cfg.database} ──\n`));

  // 1. Connect ─────────────────────────────────────────────────
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection(cfg);
    console.log(c('green', '✓') + ' DB connection OK');
  } catch (err: any) {
    console.log(c('red', '✗') + ` DB connection failed: ${err?.message}`);
    console.log(c('dim', '   Check MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE in .env.local'));
    return 1;
  }

  // 2. Table exists ────────────────────────────────────────────
  try {
    const [rows]: any = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = ? AND table_name = 'q365_signals'`,
      [cfg.database],
    );
    if (!rows?.[0]?.n) {
      console.log(c('red', '✗') + ' q365_signals table not found');
      console.log(c('dim', '   Run `npm run db:migrate-all` first.'));
      await conn.end();
      return 1;
    }
    console.log(c('green', '✓') + ' q365_signals table exists');
  } catch (err: any) {
    console.log(c('red', '✗') + ` schema probe failed: ${err?.message}`);
    await conn.end();
    return 1;
  }

  // 3a. In-place direction repair — the fast path ─────────────
  // These rows have SHORT-semantics trade plans (stop > entry,
  // target < entry). Only the `direction` column was written
  // wrong by the pre-fix Phase 4 save. Flipping the label makes
  // the row internally consistent and immediately visible as
  // SELL in the API.
  if (FIX_DIRECTION) {
    const placeholders = Array.from(BEARISH).map(() => '?').join(',');
    const [res]: any = await conn.query(
      `UPDATE q365_signals
         SET direction = 'SELL'
       WHERE direction  = 'BUY'
         AND signal_type IN (${placeholders})`,
      [...BEARISH],
    );
    console.log(c('yellow', `⚠ repaired ${res?.affectedRows ?? 0} mislabelled rows (BUY → SELL on bearish strategies)`));
  }

  // 3b. OR: expire mislabelled rows (no status predicate — catches
  // every legacy row regardless of active/watchlist/expired/etc.)
  if (EXPIRE_STALE && !FIX_DIRECTION) {
    const placeholders = Array.from(BEARISH).map(() => '?').join(',');
    const [res]: any = await conn.query(
      `UPDATE q365_signals
         SET status = 'expired', expires_at = NOW()
       WHERE direction  = 'BUY'
         AND signal_type IN (${placeholders})
         AND generated_at > NOW() - INTERVAL 7 DAY`,
      [...BEARISH],
    );
    console.log(c('yellow', `⚠ expired ${res?.affectedRows ?? 0} mislabelled BUY-but-bearish rows`));
  }

  // 4. Direction × strategy breakdown over the last 24h ────────
  const [rowsBreak]: any = await conn.query(
    `SELECT direction, signal_type, COUNT(*) AS n
       FROM q365_signals
      WHERE generated_at > NOW() - INTERVAL 24 HOUR
      GROUP BY direction, signal_type
      ORDER BY direction, n DESC`,
  );

  if (!rowsBreak.length) {
    console.log(c('yellow', '⚠') + ' no signals generated in the last 24h — run the pipeline first');
    console.log(c('dim', '   curl http://localhost:5000/api/run-signal-engine'));
    await conn.end();
    return 1;
  }

  let buyCount  = 0;
  let sellCount = 0;
  const mislabelled: Array<{ direction: string; signal_type: string; n: number }> = [];

  for (const r of rowsBreak) {
    const dir = String(r.direction ?? '').toUpperCase();
    const typ = String(r.signal_type ?? '');
    const n   = Number(r.n);
    if (dir === 'BUY')  buyCount  += n;
    if (dir === 'SELL') sellCount += n;
    // Mislabelled = bearish strategy but direction='BUY' (the bug).
    if (dir === 'BUY' && BEARISH.has(typ)) {
      mislabelled.push({ direction: dir, signal_type: typ, n });
    }
  }

  console.log(c('dim', '\n── Direction breakdown (last 24h) ──'));
  console.log(`  BUY:  ${buyCount}`);
  console.log(`  SELL: ${sellCount}`);

  if (VERBOSE) {
    console.log(c('dim', '\n── By strategy ──'));
    for (const r of rowsBreak) {
      const dir = String(r.direction ?? '');
      const typ = String(r.signal_type ?? '');
      const n   = Number(r.n);
      const flag = (dir === 'BUY' && BEARISH.has(typ)) ? c('red', '   ← mislabelled') : '';
      console.log(`  ${dir.padEnd(5)}  ${typ.padEnd(28)}  ${String(n).padStart(4)}${flag}`);
    }
  }

  await conn.end();

  // 5. Verdict ─────────────────────────────────────────────────
  console.log('');
  let rc = 0;

  if (mislabelled.length > 0) {
    const total = mislabelled.reduce((s, x) => s + x.n, 0);
    console.log(c('red', '✗') + ` ${total} row(s) still have direction='BUY' on a bearish strategy:`);
    for (const m of mislabelled) {
      console.log(c('red', `    ${m.signal_type}: ${m.n}`));
    }
    console.log(c('dim', '   These are rows generated BEFORE the Phase 4 action-mapping fix.'));
    console.log(c('dim', '   Fastest fix — flip the direction label in place (trade plans are'));
    console.log(c('dim', '   already short-semantics, so this is a safe one-time data repair):'));
    console.log(c('dim', '     npm run verify:sell-fix -- --fix-direction'));
    rc = 1;
  }

  if (sellCount === 0) {
    console.log(c('red', '✗') + ' SELL count = 0. Either no bearish setups in current tape, or fix not effective.');
    console.log(c('dim', '   Check [STRATEGY SUMMARY] in server logs for sell_generated.'));
    rc = 1;
  } else if (sellCount < 5) {
    console.log(c('yellow', '⚠') + ` SELL count = ${sellCount} — thin but non-zero. May be market-driven.`);
  } else {
    console.log(c('green', '✓') + ` SELL = ${sellCount} — fix is effective`);
  }

  if (rc === 0) {
    console.log(c('green', '\n✓ verifySellFix PASSED\n'));
  } else {
    console.log(c('red', '\n✗ verifySellFix FAILED\n'));
  }
  return rc;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `\nverifySellFix crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
