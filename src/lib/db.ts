import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';

// Persist pool across Next.js hot reloads in dev
const g = global as any;

/** Convert PostgreSQL $1, $2 placeholders to MySQL ? placeholders.
 *  If SQL already uses ?, pass params through as-is. */
function toMysqlParams(sql: string, params?: any[]): [string, any[]] {
  if (!params?.length) return [sql, []];

  // PostgreSQL-style $1, $2 — convert to ?
  if (/\$[0-9]+/.test(sql)) {
    const newParams: any[] = [];
    const newSql = sql.replace(/\$([0-9]+)/g, (_match, num) => {
      const idx = parseInt(num, 10) - 1;
      newParams.push(idx >= 0 && idx < params.length ? params[idx] : null);
      return '?';
    });
    return [newSql, newParams];
  }

  // MySQL-style ? — params already in correct order
  return [sql, params];
}

/** Convert PostgreSQL INTERVAL to MySQL DATE_SUB */
function convertInterval(sql: string): string {
  return sql.replace(
    /NOW\(\)\s*-\s*INTERVAL\s+'(\d+)\s+(\w+)'/gi,
    (_, n, unit) => {
      const u = unit.toLowerCase().replace(/s$/, '').toUpperCase();
      const map: Record<string, string> = {
        DAY: 'DAY', HOUR: 'HOUR', WEEK: 'WEEK', MONTH: 'MONTH', YEAR: 'YEAR',
        MINUTE: 'MINUTE', SECOND: 'SECOND',
      };
      return `DATE_SUB(NOW(), INTERVAL ${n} ${map[u] || 'DAY'})`;
    }
  );
}

/** Convert PostgreSQL ILIKE to MySQL LIKE */
function convertIlike(sql: string): string {
  return sql.replace(/ILIKE/gi, 'LIKE');
}

/** Convert PostgreSQL ON CONFLICT to MySQL ON DUPLICATE KEY UPDATE */
function convertOnConflict(sql: string): string {
  return sql.replace(
    /ON CONFLICT\s*\([^)]+\)\s*DO UPDATE SET\s+([^;]+)/gi,
    (_, setClause) => {
      const mysqlSet = setClause.replace(/(\w+)=\$(\d+)/g, (m: string, col: string, _n: string) => {
        return `${col}=VALUES(${col})`;
      });
      return `ON DUPLICATE KEY UPDATE ${mysqlSet}`;
    }
  );
}

function prepareSql(sql: string, params?: any[]): [string, any[]] {
  const converted = convertInterval(convertIlike(convertOnConflict(sql)));
  return toMysqlParams(converted, params);
}

/** Handle INSERT ... RETURNING for MySQL */
async function handleReturning(
  pool: mysql.Pool,
  sql: string,
  params: any[]
): Promise<{ rows: any[] }> {
  const returnIdMatch  = sql.match(/RETURNING\s+id\s*$/i);
  const returnAllMatch = sql.match(/RETURNING\s+\*\s*$/i);
  const insertMatch    = sql.match(/INSERT\s+INTO\s+(\w+)/i);

  const baseSql = sql.replace(/\s*RETURNING\s+(id|\*)\s*$/i, '').trim();
  const [mysqlSql, mysqlParams] = prepareSql(baseSql, params);

  const [result] = await pool.query<ResultSetHeader>(mysqlSql, mysqlParams);
  const header   = result as unknown as ResultSetHeader;

  if (returnIdMatch && header.insertId) {
    return { rows: [{ id: header.insertId }] };
  }

  if (returnAllMatch && insertMatch && header.insertId) {
    const table = insertMatch[1];
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM \`${table}\` WHERE id = ?`,
      [header.insertId]
    );
    return { rows: Array.isArray(rows) ? rows : [rows] };
  }

  return { rows: [] };
}

/** Execute any query and return pg-compatible { rows } */
async function executeQuery(
  pool: mysql.Pool,
  sql: string,
  params?: any[]
): Promise<{ rows: any[] }> {
  const [mysqlSql, mysqlParams] = prepareSql(sql, params);
  const [rows] = await pool.query<RowDataPacket[]>(mysqlSql, mysqlParams);
  const arr = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  return { rows: arr };
}

/**
 * Canonical MySQL connection config. Prefers discrete MYSQL_* env vars
 * (MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE);
 * falls back to parsing a DATABASE_URL if the operator is still using
 * the old connection-string form. Throws a clear error if neither is set.
 *
 * Exported so one-shot migration / setup scripts can share the exact
 * same host/user/password resolution the pool uses, instead of each
 * script parsing DATABASE_URL independently.
 */
export function getMysqlConnectionConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  const host = process.env.MYSQL_HOST?.trim();
  const user = process.env.MYSQL_USER?.trim();
  const database = process.env.MYSQL_DATABASE?.trim();
  // Password may legitimately contain leading/trailing spaces in rare
  // cases but MySQL doesn't allow them — we trim to match what the
  // operator almost certainly meant when typing into .env.local.
  const password = process.env.MYSQL_PASSWORD?.trim() ?? '';
  const portRaw = process.env.MYSQL_PORT?.trim();
  const port = portRaw ? parseInt(portRaw, 10) : 3306;

  if (host && user && database) {
    return { host, port, user, password, database };
  }

  // Backward-compat: synthesize config from DATABASE_URL if provided.
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const parsed = new URL(url);
    return {
      host:     parsed.hostname,
      port:     parsed.port ? parseInt(parsed.port, 10) : 3306,
      user:     decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname?.slice(1) || 'quantorus365',
    };
  }

  throw new Error(
    'MySQL connection not configured — set MYSQL_HOST / MYSQL_USER / ' +
    'MYSQL_PASSWORD / MYSQL_DATABASE in .env.local',
  );
}

export function getDb(): mysql.Pool {
  if (!g.__mysqlPool) {
    const cfg = getMysqlConnectionConfig();
    g.__mysqlPool = mysql.createPool({
      host:             cfg.host,
      port:             cfg.port,
      user:             cfg.user,
      password:         cfg.password,
      database:         cfg.database,
      waitForConnections: true,
      connectionLimit:  10,
      queueLimit:       0,
      namedPlaceholders: false,
      multipleStatements: false,
    });
  }
  return g.__mysqlPool;
}

export const db = {
  query: async <T = any>(text: string, params?: any[]): Promise<{ rows: T[]; insertId?: number; affectedRows?: number }> => {
    const p = getDb();

    if (/INSERT\s+INTO[\s\S]*RETURNING/i.test(text)) {
      return handleReturning(p, text, params || []) as Promise<{ rows: T[] }>;
    }

    // For INSERT/UPDATE/DELETE, extract metadata from ResultSetHeader
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\s/i.test(text)) {
      const [mysqlSql, mysqlParams] = prepareSql(text, params);
      const [result] = await p.query(mysqlSql, mysqlParams);
      const header = result as unknown as ResultSetHeader;
      return {
        rows: [] as T[],
        insertId: header.insertId ?? undefined,
        affectedRows: header.affectedRows ?? undefined,
      };
    }

    const { rows } = await executeQuery(p, text, params);
    return { rows: rows as T[] };
  },
};
