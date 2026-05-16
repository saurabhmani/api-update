/**
 * reclassifyNewsSentiment — one-shot back-fill for q365_news_events
 * rows whose sentiment / category was computed by an older classifier
 * and never refreshed. Reconstructs a RawNewsItem from each stored row,
 * runs it through normalizeRawItem (current rules), and UPDATEs the
 * sentiment / sentiment_score / category columns in place when they
 * differ from the stored values.
 *
 * This is the companion to rebuildSymbolIndex.ts — same pattern,
 * different columns. Together they repair labels baked in before the
 * classifier and resolver were upgraded.
 *
 * Run:  npm run news:reclassify
 * Flags:
 *   --dry-run     Scan, show what would change, don't write.
 *   --limit=N     Cap rows to process (default: no cap).
 *   --since=24h   Only rows with published_at within the last N hours
 *                 (default: all rows in the last 7 days).
 *
 * Exits 0 on success, 1 on DB/runtime error.
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

require('tsconfig-paths/register');

const argv    = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const LIMIT = (() => {
  const flag = argv.find((a) => a.startsWith('--limit='));
  if (!flag) return null;
  const n = Number(flag.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const SINCE_HOURS = (() => {
  const flag = argv.find((a) => a.startsWith('--since='));
  if (!flag) return 7 * 24; // default: 7 days
  const raw = flag.split('=')[1];
  const m = /^(\d+)(h|d)?$/.exec(raw);
  if (!m) return 7 * 24;
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 24 : n;
})();

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = {
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m',
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

  console.log(c('dim', `\n── reclassifyNewsSentiment — ${cfg.host}:${cfg.port}/${cfg.database} ──`));
  console.log(c('dim', `  mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`));
  console.log(c('dim', `  window:     last ${SINCE_HOURS}h`));
  console.log(c('dim', `  limit:      ${LIMIT ?? 'none'}\n`));

  // Lazy import of the normalizer so path-aliases resolve.
  const { normalizeRawItem } = await import('@/lib/news-engine/normalization/normalizeEvent');

  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection(cfg);
    console.log(c('green', '✓') + ' DB connection OK');
  } catch (err: any) {
    console.log(c('red', '✗') + ` DB connection failed: ${err?.message}`);
    return 1;
  }

  const sql = `
    SELECT id, source_id, external_id, title, body, url,
           published_at, fetched_at, category, sentiment, sentiment_score
      FROM q365_news_events
     WHERE published_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY id DESC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `;
  const [rows]: any = await conn.query(sql, [SINCE_HOURS]);

  console.log(c('dim', `  candidates: ${rows.length}\n`));

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const shifts: Record<string, number> = {};

  for (const row of rows) {
    const title = String(row.title ?? '');
    const body  = row.body != null ? String(row.body) : null;
    if (!title) { skipped++; continue; }

    const raw = {
      sourceId:    row.source_id as any,
      externalId:  String(row.external_id ?? ''),
      title,
      body,
      url:         String(row.url ?? ''),
      publishedAt: row.published_at instanceof Date
        ? row.published_at.toISOString()
        : String(row.published_at ?? ''),
      fetchedAt:   row.fetched_at instanceof Date
        ? row.fetched_at.toISOString()
        : String(row.fetched_at ?? ''),
    };

    const reclassified = normalizeRawItem(raw);
    if (!reclassified) { skipped++; continue; }

    const oldLabel = String(row.sentiment ?? '').toLowerCase();
    const newLabel = String(reclassified.sentiment ?? '').toLowerCase();
    const oldCat   = String(row.category ?? '');
    const newCat   = String(reclassified.category ?? '');
    const oldScore = Number(row.sentiment_score ?? 0);
    const newScore = Number(reclassified.sentimentScore ?? 0);

    const labelChanged    = oldLabel !== newLabel;
    const categoryChanged = oldCat   !== newCat;
    const scoreChanged    = Math.abs(oldScore - newScore) > 0.01;

    if (!labelChanged && !categoryChanged && !scoreChanged) {
      unchanged++;
      continue;
    }

    const shiftKey = `${oldLabel || '_'} → ${newLabel}`;
    shifts[shiftKey] = (shifts[shiftKey] ?? 0) + 1;

    if (DRY_RUN) {
      updated++;
      if (labelChanged) {
        console.log(c('yellow', '  [dry]') +
          ` id=${String(row.id).padStart(6)}  ${oldLabel.padEnd(20)} → ${newLabel.padEnd(20)}  "${title.slice(0, 64)}"`);
      }
      continue;
    }

    await conn.query(
      `UPDATE q365_news_events
          SET sentiment       = ?,
              sentiment_score = ?,
              category        = ?,
              updated_at      = NOW()
        WHERE id = ?`,
      [reclassified.sentiment, reclassified.sentimentScore, reclassified.category, row.id],
    );
    updated++;
  }

  await conn.end();

  console.log('');
  console.log(c('green', '✓') + ` updated:   ${updated}`);
  console.log(c('dim',   '  unchanged: ') + `${unchanged}`);
  console.log(c('dim',   '  skipped:   ') + `${skipped}  ${c('dim', '(missing title or failed validation)')}`);

  if (Object.keys(shifts).length > 0) {
    console.log(c('dim', '\n  Label shifts:'));
    const entries = Object.entries(shifts).sort(([, a], [, b]) => b - a);
    for (const [shift, n] of entries) {
      console.log(`    ${shift.padEnd(40)}  ${String(n).padStart(4)}`);
    }
  }

  console.log(updated > 0
    ? c('green', '\n✓ reclassifyNewsSentiment complete — run `npm run verify:news` to confirm.\n')
    : c('yellow', '\n⚠ no rows needed reclassification — classifier output matches stored values.\n'));

  return 0;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `\nreclassifyNewsSentiment crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
