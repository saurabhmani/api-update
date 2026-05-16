/**
 * verifyNewsPipeline — pinpoint why the /news-intelligence page shows
 * "Invalid Date" / "Symbols Impacted = 0". Walks the DB stage-by-stage
 * and reports where the count collapses to zero.
 *
 * Run:  npm run verify:news
 * Flags:
 *   --run-pipeline   POST /api/news-engine to force an ingestion+scoring cycle
 *                    before reading (server must be running on localhost).
 *   --verbose        Print per-source ingestion and sample article rows.
 *
 * Exit 0 on healthy pipeline, 1 on any stage being empty / malformed.
 */
import fs    from 'fs';
import path  from 'path';
import mysql from 'mysql2/promise';

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

const argv         = process.argv.slice(2);
const RUN_PIPELINE = argv.includes('--run-pipeline');
const VERBOSE      = argv.includes('--verbose');

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = {
    red:    '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', dim:   '\x1b[2m',
  };
  return `${map[col]}${s}\x1b[0m`;
}

async function main(): Promise<number> {
  const cfg = {
    host:     process.env.MYSQL_HOST     || '127.0.0.1',
    port:     Number(process.env.MYSQL_PORT || 3306),
    user:     process.env.MYSQL_USER     || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'quantorus365',
  };
  console.log(c('dim', `\n── verifyNewsPipeline — ${cfg.host}:${cfg.port}/${cfg.database} ──\n`));

  let rc = 0;

  // 0. Optional pipeline kick ─────────────────────────────────
  // Call runFullPipeline directly in-process instead of hitting the
  // /api/news-engine HTTP route. The HTTP route is behind
  // requireSession() (returns 401 without a logged-in cookie), which
  // isn't practical from a CLI script. The in-process path reads the
  // exact same adapters, normalizer, and DB writes — just without the
  // auth wrapper. Requires tsconfig-paths so the `@/…` aliases
  // resolve identically to the Next runtime.
  if (RUN_PIPELINE) {
    try {
      // Lazy import so a missing dep in this module doesn't break the
      // rest of the script (e.g. when the pipeline's own deps need a
      // schema that hasn't been migrated yet).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('tsconfig-paths/register');
      const mod = await import('@/lib/news-engine/pipeline/runNewsPipeline');
      console.log(c('dim', '  running runFullPipeline (in-process)…'));
      const result: any = await mod.runFullPipeline('Indian stock market NSE', 15);
      console.log(c('green', '✓') +
        ` pipeline ran — ingested=${result?.ingestion?.newEvents ?? 0}` +
        ` duplicates=${result?.ingestion?.duplicatesSkipped ?? 0}` +
        ` scored=${result?.scoring?.symbolScores ?? 0}` +
        ` errors=${result?.ingestion?.errors?.length ?? 0}`);
      if (result?.ingestion?.errors?.length) {
        for (const e of result.ingestion.errors.slice(0, 3)) {
          console.log(c('yellow', `    err: ${e}`));
        }
      }
    } catch (err: any) {
      console.log(c('red', '✗') + ` in-process pipeline failed: ${err?.message ?? err}`);
      if (VERBOSE && err?.stack) console.log(c('dim', err.stack));
    }
  }

  // 1. DB connect ─────────────────────────────────────────────
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection(cfg);
    console.log(c('green', '✓') + ' DB connection OK');
  } catch (err: any) {
    console.log(c('red', '✗') + ` DB connection failed: ${err?.message}`);
    return 1;
  }

  // 2. Stage counts ───────────────────────────────────────────
  const [[events]]:   any = await conn.query(
    `SELECT COUNT(*) AS n FROM q365_news_events
      WHERE published_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)`);
  const [[withSyms]]: any = await conn.query(
    `SELECT COUNT(*) AS n FROM q365_news_events
      WHERE published_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
        AND JSON_LENGTH(symbols_json) > 0`);
  const [[scored]]:   any = await conn.query(
    `SELECT COUNT(*) AS n FROM q365_news_scores
      WHERE scored_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)`);
  const [[uniqSyms]]: any = await conn.query(
    `SELECT COUNT(DISTINCT symbol) AS n FROM q365_news_scores
      WHERE scored_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
        AND symbol <> 'MARKET'`);
  const [[badDates]]: any = await conn.query(
    `SELECT COUNT(*) AS n FROM q365_news_events
      WHERE published_at IS NULL
         OR published_at = '0000-00-00 00:00:00'
         OR published_at < '2015-01-01'
         OR published_at > DATE_ADD(NOW(), INTERVAL 2 DAY)`);

  const E       = Number(events.n);
  const Esymb   = Number(withSyms.n);
  const S       = Number(scored.n);
  const Usym    = Number(uniqSyms.n);
  const Dbad    = Number(badDates.n);

  console.log(c('dim', '\n── Pipeline stage counts (last 48h) ──'));
  console.log(`  news_events_total:              ${E}`);
  console.log(`  news_events_with_symbols:       ${Esymb}` +
    (Esymb === 0 && E > 0 ? c('red', '  ← entity resolver extracted 0 symbols') : ''));
  console.log(`  news_score_cards:               ${S}` +
    (S === 0 && E > 0 ? c('red', '  ← scoring never ran or errored') : ''));
  console.log(`  unique_symbols_scored:          ${Usym}` +
    (Usym === 0 ? c('red', '  ← this is what "Symbols Impacted = 0" reads') : ''));
  console.log(`  malformed_published_at_rows:    ${Dbad}` +
    (Dbad > 0 ? c('red', '  ← will render as "Invalid Date"') : ''));

  // 3. Sentiment distribution ─────────────────────────────────
  const [sentRows]: any = await conn.query(
    `SELECT sentiment, COUNT(*) AS n FROM q365_news_events
      WHERE published_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
      GROUP BY sentiment`);
  console.log(c('dim', '\n── Sentiment distribution ──'));
  for (const r of sentRows) {
    console.log(`  ${String(r.sentiment ?? 'null').padEnd(22)}  ${r.n}`);
  }
  if (sentRows.length === 1 && sentRows[0].sentiment === 'neutral') {
    console.log(c('yellow', '  ⚠ every article is neutral — keyword classifier may not be matching'));
  }

  // 4. Verbose sample ─────────────────────────────────────────
  if (VERBOSE) {
    const [sample]: any = await conn.query(
      `SELECT id, title, published_at, sentiment, symbols_json
         FROM q365_news_events
        WHERE published_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
        ORDER BY published_at DESC LIMIT 8`);
    console.log(c('dim', '\n── Sample rows ──'));
    for (const r of sample) {
      const syms = (() => { try { return JSON.parse(r.symbols_json ?? '[]'); } catch { return []; } })();
      console.log(`  ${String(r.id).padStart(5)}  ${String(r.published_at).padEnd(24)}  ${r.sentiment?.padEnd(10)}  [${syms.join(',') || '-'}]  ${String(r.title).slice(0, 60)}`);
    }
  }

  await conn.end();

  // 5. Verdict ───────────────────────────────────────────────
  console.log('');
  if (E === 0) {
    console.log(c('red', '✗') + ' no news events in last 48h. Run the pipeline:');
    console.log(c('dim', '   npm run verify:news -- --run-pipeline'));
    rc = 1;
  } else if (Esymb === 0) {
    console.log(c('red', '✗') + ` ${E} articles fetched but ZERO have symbols extracted`);
    console.log(c('dim', '   Check src/lib/news-engine/entity-linking/entityResolver.ts — KNOWN_SYMBOLS + COMPANY_ALIASES.'));
    console.log(c('dim', '   Likely cause: ingested articles do not mention any NSE symbol by its ticker or known alias.'));
    rc = 1;
  } else if (S === 0) {
    console.log(c('red', '✗') + ` ${E} articles + ${Esymb} with symbols, but ZERO score cards written`);
    console.log(c('dim', '   Scoring stage never ran or silently failed. Check server logs.'));
    console.log(c('dim', '   Force a run: npm run verify:news -- --run-pipeline'));
    rc = 1;
  } else if (Usym === 0) {
    console.log(c('red', '✗') + ` ${S} score cards but 0 unique non-MARKET symbols`);
    console.log(c('dim', '   Every card was written against the synthetic "MARKET" target.'));
    console.log(c('dim', '   Entity resolver is not populating event.symbols before scoring.'));
    rc = 1;
  } else {
    console.log(c('green', '✓') + ` pipeline healthy — ${Usym} unique symbol(s) across ${S} score cards`);
  }

  if (Dbad > 0) {
    console.log(c('red', '✗') + ` ${Dbad} rows have malformed published_at (will render as Invalid Date)`);
    console.log(c('dim', '   These are legacy rows from before the date-parse fix.'));
    console.log(c('dim', "   Safe to delete: UPDATE q365_news_events SET published_at = fetched_at WHERE ...."));
    rc = 1;
  }

  console.log(rc === 0
    ? c('green', '\n✓ verifyNewsPipeline PASSED\n')
    : c('red',   '\n✗ verifyNewsPipeline FAILED\n'));
  return rc;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `\nverifyNewsPipeline crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
