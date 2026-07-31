import { config as dotenvConfig } from 'dotenv';
import mysql from 'mysql2/promise';

dotenvConfig({ path: '.env.local' });

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectTimeout: 10_000,
});

const queries = [
  {
    name: 'active_confirmed_snapshots',
    sql: `SELECT s.id, s.source_signal_id, s.symbol, s.direction,
                 s.confidence_score, s.final_score, s.classification,
                 mt.maturity_score, mt.validation_cycles_passed,
                 q.confidence_score AS source_confidence_score
            FROM q365_confirmed_signal_snapshots s
            LEFT JOIN q365_signal_maturity_tracker mt
              ON mt.symbol = s.symbol AND mt.direction = s.direction
            LEFT JOIN q365_signals q ON q.id = s.source_signal_id
           WHERE s.status = 'ACTIVE'
             AND s.valid_until > NOW()
             AND UPPER(s.classification) IN (
               'INSTITUTIONAL_HIGH_CONVICTION','HIGH_CONVICTION',
               'VALID_SIGNAL','HIGH_CONVICTION_BUY','VALID_BUY'
             )
           ORDER BY COALESCE(s.final_score, s.confidence_score, 0) DESC,
                    s.confidence_score DESC, s.confirmed_at DESC, s.id ASC
           LIMIT 20`,
  },
  {
    name: 'in_progress_trackers',
    sql: `SELECT t.id, t.symbol, t.direction, t.maturity_score, t.stage,
                 t.last_seen_at, s.id AS signal_id, s.confidence_score,
                 s.final_score, s.market_regime, s.decay_state, s.scenario_tag
            FROM q365_signal_maturity_tracker t
            LEFT JOIN q365_signals s ON s.id = t.last_signal_id
           WHERE t.stage IN ('candidate','developing','mature')
             AND t.maturity_score >= 30
             AND t.last_seen_at >= DATE_SUB(NOW(), INTERVAL 6 HOUR)
             AND (s.decay_state IS NULL OR s.decay_state NOT IN ('expired','stale'))
           ORDER BY t.stage = 'mature' DESC,
                    t.stage = 'developing' DESC,
                    t.maturity_score DESC, t.last_seen_at DESC
           LIMIT 50`,
  },
  {
    name: 'snapshot_read_meta',
    sql: `SELECT UNIX_TIMESTAMP(MAX(confirmed_at)) AS latest_ts,
                 SUM(status='ACTIVE' AND valid_until>NOW()) AS active_count,
                 COUNT(*) AS total_lifetime
            FROM q365_confirmed_signal_snapshots`,
  },
  {
    name: 'tracker_counts',
    sql: `SELECT stage, COUNT(*) AS count
            FROM q365_signal_maturity_tracker
           WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 6 HOUR)
           GROUP BY stage`,
  },
];

const tables = [
  'user_sessions',
  'q365_confirmed_signal_snapshots',
  'q365_signal_maturity_tracker',
  'q365_signals',
];

try {
  const report = { generatedAt: new Date().toISOString(), queries: [], indexes: {} };
  for (const item of queries) {
    const explainStartedAt = performance.now();
    const [planRows] = await connection.query(`EXPLAIN ${item.sql}`);
    const explainMs = performance.now() - explainStartedAt;
    const queryStartedAt = performance.now();
    const [rows] = await connection.query(item.sql);
    const executionMs = performance.now() - queryStartedAt;
    report.queries.push({
      name: item.name,
      executionMs: Number(executionMs.toFixed(3)),
      explainMs: Number(explainMs.toFixed(3)),
      rowsReturned: rows.length,
      plan: planRows.map((row) => ({
        table: row.table,
        accessType: row.type,
        possibleKeys: row.possible_keys,
        key: row.key,
        rowsExaminedEstimate: row.rows,
        filteredPercent: row.filtered,
        extra: row.Extra,
      })),
    });
  }
  for (const table of tables) {
    const [rows] = await connection.query(`SHOW INDEX FROM \`${table}\``);
    report.indexes[table] = rows.map((row) => ({
      name: row.Key_name,
      unique: Number(row.Non_unique) === 0,
      sequence: row.Seq_in_index,
      column: row.Column_name,
      cardinality: row.Cardinality,
    }));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await connection.end();
}
