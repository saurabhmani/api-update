// ════════════════════════════════════════════════════════════════
//  sqlRewriteHelper.ts — MySQL → Postgres lint for the 157 files
//
//  Scans every *.ts file under src/ for MySQL-specific SQL syntax
//  and emits a report naming each file, line, matched pattern, and
//  suggested Postgres replacement.
//
//  Exit codes:
//    0 — no violations found (or --quiet)
//    1 — at least one violation
//    2 — I/O error
//
//  Usage:
//    tsx scripts/sqlRewriteHelper.ts
//    tsx scripts/sqlRewriteHelper.ts --out=sql-rewrite-report.md
//    tsx scripts/sqlRewriteHelper.ts --path=src/lib/db          # narrow to a dir
//    tsx scripts/sqlRewriteHelper.ts --pattern=mysql-specific   # only one rule
//
//  Output formats:
//    default  — human console + writes sql-rewrite-report.md
//    --json   — machine-readable
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

interface Rule {
  id: string;
  description: string;
  pattern: RegExp;
  suggest: (match: string) => string;
}

// Heuristics — not perfect parsing, but good enough to flag the files
// for a human review pass. Every rule is intentionally conservative:
// false positives are easy to dismiss; false negatives silently hide
// incompatibilities that break at migration cutover.
const RULES: Rule[] = [
  {
    id: 'mysql-backtick-ident',
    description: 'Backtick-quoted identifiers are MySQL-only. Use double quotes (optional in Postgres for lowercase names).',
    pattern: /`[a-zA-Z_][a-zA-Z0-9_]*`/g,
    suggest: (m) => `"${m.slice(1, -1)}"`,
  },
  {
    id: 'mysql-on-duplicate-key',
    description: 'MySQL UPSERT syntax — rewrite as ON CONFLICT (...) DO UPDATE SET ...',
    pattern: /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi,
    suggest: () => 'ON CONFLICT (<unique-cols>) DO UPDATE SET <col = EXCLUDED.col>',
  },
  {
    id: 'mysql-date-sub-interval',
    description: 'Replace DATE_SUB(..., INTERVAL n UNIT) with NOW() - INTERVAL \'n UNIT\'.',
    pattern: /DATE_SUB\s*\(\s*NOW\(\)\s*,\s*INTERVAL\s+(\d+)\s+(\w+)\s*\)/gi,
    suggest: (m) => {
      const match = m.match(/INTERVAL\s+(\d+)\s+(\w+)/i);
      return match ? `NOW() - INTERVAL '${match[1]} ${match[2]}'` : "NOW() - INTERVAL '…'";
    },
  },
  {
    id: 'mysql-ifnull',
    description: 'Use COALESCE(x, y) in Postgres.',
    pattern: /\bIFNULL\s*\(/gi,
    suggest: () => 'COALESCE(',
  },
  {
    id: 'mysql-unix-timestamp',
    description: 'Use EXTRACT(EPOCH FROM ts)::bigint in Postgres.',
    pattern: /\bUNIX_TIMESTAMP\s*\(/gi,
    suggest: () => 'EXTRACT(EPOCH FROM …)::bigint',
  },
  {
    id: 'mysql-from-unixtime',
    description: 'Use to_timestamp(ms / 1000.0) in Postgres.',
    pattern: /\bFROM_UNIXTIME\s*\(/gi,
    suggest: () => 'to_timestamp(… / 1000.0)',
  },
  {
    id: 'mysql-group-concat',
    description: 'Use STRING_AGG(col::text, \',\') in Postgres.',
    pattern: /\bGROUP_CONCAT\s*\(/gi,
    suggest: () => 'STRING_AGG(col::text, \',\')',
  },
  {
    id: 'mysql-like-case-insensitive',
    description: 'MySQL LIKE is case-insensitive by default collation; Postgres is not. Use ILIKE or add collation.',
    pattern: /\bLIKE\s+[\$\?]/g,
    suggest: () => 'ILIKE $1',
  },
  {
    id: 'mysql-question-placeholder',
    description: 'Replace ? placeholders with $1, $2, ... for Postgres.',
    pattern: /(?:VALUES\s*\([^)]*\?[^)]*\))|(?:=\s*\?)/g,
    suggest: () => 'Use $1, $2, $3 positional params',
  },
  {
    id: 'mysql-last-insert-id',
    description: 'Use INSERT … RETURNING id instead of LAST_INSERT_ID().',
    pattern: /\bLAST_INSERT_ID\s*\(\s*\)/gi,
    suggest: () => 'INSERT … RETURNING id  (then read rows[0].id)',
  },
  {
    id: 'mysql-datetime-type',
    description: 'Use TIMESTAMPTZ instead of DATETIME in column definitions.',
    pattern: /\bDATETIME\b/g,
    suggest: () => 'TIMESTAMPTZ',
  },
  {
    id: 'mysql-tinyint-bool',
    description: 'Use BOOLEAN instead of TINYINT(1).',
    pattern: /\bTINYINT\s*\(\s*1\s*\)/gi,
    suggest: () => 'BOOLEAN',
  },
  {
    id: 'mysql-json-func',
    description: 'MySQL JSON_EXTRACT / JSON_UNQUOTE — use ->/->>/jsonb operators in Postgres.',
    pattern: /\bJSON_(EXTRACT|UNQUOTE|ARRAY|OBJECT|SET|REPLACE|REMOVE|KEYS|VALUE)\s*\(/gi,
    suggest: () => "col->'key' or col->>'key' or jsonb_set(...)",
  },
];

// ── Args ───────────────────────────────────────────────────────────

const argv = new Map(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const outPath   = argv.get('out') ?? 'sql-rewrite-report.md';
const rootDir   = path.resolve(process.cwd(), argv.get('path') ?? 'src');
const onlyRule  = argv.get('pattern');
const jsonMode  = argv.has('json');
const quiet     = argv.has('quiet');

// ── Walker ─────────────────────────────────────────────────────────

function walkTs(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(full, out);
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── Matcher ────────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  rule: string;
  description: string;
  match: string;
  suggestion: string;
  snippet: string;
}

function scanFile(file: string): Violation[] {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');
  const out: Violation[] = [];

  for (const rule of RULES) {
    if (onlyRule && rule.id !== onlyRule) continue;
    rule.pattern.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments-only lines
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
      // Skip unless the line looks like SQL (heuristic: contains SELECT/INSERT/UPDATE/DELETE/CREATE/db\.query)
      const looksLikeSql =
        /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|REPLACE|MERGE)\b/i.test(line) ||
        /\.query\s*\(/.test(line) ||
        /sql\s*=|sql\s*:|sql:\s*`/.test(line);
      if (!looksLikeSql && rule.id !== 'mysql-datetime-type' && rule.id !== 'mysql-tinyint-bool') continue;

      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        out.push({
          file: path.relative(process.cwd(), file),
          line: i + 1,
          rule: rule.id,
          description: rule.description,
          match: m[0],
          suggestion: rule.suggest(m[0]),
          snippet: line.trim().slice(0, 160),
        });
        if (m.index === re.lastIndex) re.lastIndex += 1;
      }
    }
  }
  return out;
}

// ── Runner ─────────────────────────────────────────────────────────

function main(): void {
  if (!fs.existsSync(rootDir)) {
    console.error(`[sqlRewriteHelper] path not found: ${rootDir}`);
    process.exit(2);
  }
  if (!quiet) console.log(`── sqlRewriteHelper ── scanning ${rootDir}`);

  const files = walkTs(rootDir);
  const all: Violation[] = [];
  for (const f of files) {
    const violations = scanFile(f);
    all.push(...violations);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ files: files.length, violations: all }, null, 2) + '\n');
    process.exit(all.length > 0 ? 1 : 0);
  }

  // Group by file for a scannable console output.
  const byFile = new Map<string, Violation[]>();
  for (const v of all) {
    const arr = byFile.get(v.file) ?? [];
    arr.push(v);
    byFile.set(v.file, arr);
  }

  // Write markdown report.
  const md: string[] = [];
  md.push(`# MySQL → PostgreSQL rewrite report`);
  md.push('');
  md.push(`Scanned **${files.length}** TypeScript files under \`${path.relative(process.cwd(), rootDir)}\`.`);
  md.push(`Found **${all.length}** potential incompatibilities across **${byFile.size}** files.`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push('');

  // Rule totals summary
  md.push('## Summary by rule');
  md.push('');
  md.push('| Rule | Count | Description |');
  md.push('|---|---:|---|');
  const counts = new Map<string, { desc: string; count: number }>();
  for (const v of all) {
    const existing = counts.get(v.rule) ?? { desc: v.description, count: 0 };
    existing.count += 1;
    counts.set(v.rule, existing);
  }
  const sortedRules = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [rule, info] of sortedRules) {
    md.push(`| \`${rule}\` | ${info.count} | ${info.desc} |`);
  }
  md.push('');

  md.push('## File-by-file');
  md.push('');
  const filesSorted = [...byFile.keys()].sort();
  for (const file of filesSorted) {
    const violations = byFile.get(file)!;
    md.push(`### \`${file}\` — ${violations.length} violation(s)`);
    md.push('');
    md.push('| Line | Rule | Match | Suggestion |');
    md.push('|---:|---|---|---|');
    for (const v of violations) {
      const match = v.match.replace(/\|/g, '\\|');
      const suggestion = v.suggestion.replace(/\|/g, '\\|');
      md.push(`| ${v.line} | \`${v.rule}\` | \`${match}\` | ${suggestion} |`);
    }
    md.push('');
  }

  fs.writeFileSync(outPath, md.join('\n'), 'utf-8');

  if (!quiet) {
    console.log(`\n── Summary ──`);
    for (const [rule, info] of sortedRules) {
      console.log(`  ${rule.padEnd(32)} ${String(info.count).padStart(5)}  ${info.desc}`);
    }
    console.log(`\n  files-with-violations: ${byFile.size}`);
    console.log(`  total-violations:      ${all.length}`);
    console.log(`  report:                ${outPath}`);
  }

  process.exit(all.length > 0 ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error('[sqlRewriteHelper] fatal:', err);
  process.exit(2);
}
