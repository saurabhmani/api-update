import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apiRoot = path.join(root, 'src', 'app', 'api');
const out = path.join(root, 'docs', 'microservices', 'api-security-inventory.md');
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name === 'route.ts' ? [full] : [];
  });
}

function routeFor(file) {
  return '/api/' + path.relative(apiRoot, path.dirname(file)).split(path.sep).join('/');
}

function protection(source, body) {
  const text = `${source.slice(0, 4000)}\n${body}`;
  if (/requireAdmin\s*\(/.test(text)) return 'requireAdmin';
  const permission = text.match(/requirePermission\s*\([^,]+,\s*['"`]([^'"`]+)/);
  if (permission) return `requirePermission(${permission[1]})`;
  if (/requirePermission\s*\(/.test(text)) return 'requirePermission';
  if (/requireSession\s*\(/.test(text)) return 'requireSession';
  if (/validateSession|authenticateRequest|getSession\s*\(|sessionService\.|handleMfa(?:Get|Post)/.test(text)) return 'Equivalent session validation';
  if (/verifyInternal|service.?token|INTERNAL_API|cron.?secret|authorization/i.test(text)) return 'Route-specific internal authorization';
  return 'None detected';
}

function classify(route, method, guard, source) {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (/deprecated/i.test(source)) return 'Deprecated';
  if (/disabled|not implemented/i.test(source) && /501|410/.test(source)) return 'Disabled';
  if (guard === 'requireAdmin') return 'Admin-only';
  if (guard.startsWith('requirePermission')) return 'Role or permission protected';
  if (guard === 'requireSession' || guard === 'Equivalent session validation') return 'Authenticated user';
  if (/\/api\/(?:internal|workers?|cron|jobs?)(?:\/|$)/.test(route)) return 'Internal worker';
  if (/\/api\/(?:metrics|health|monitoring|status)(?:\/|$)/.test(route)) return 'Operational monitoring';
  if (/debug|diagnostic|test-|dev(?:\/|$)/.test(route)) return 'Development or debug';
  if (/\/api\/public(?:\/|$)|\/api\/(?:contact|corporate|openapi)(?:\/|$)/.test(route)) return 'Public';
  if (!mutating && /\/api\/(?:health|status|market-status)(?:\/|$)/.test(route)) return 'Public';
  return guard === 'None detected' ? 'Unknown' : 'Authenticated user';
}

function riskFor(route, method, guard, classification, source) {
  if (classification === 'Disabled' || classification === 'Deprecated') return 'Low';
  if (guard !== 'None detected') return 'Low';
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (mutating && /process|queue|scan|seed|reseed|backfill|migrat|admin|execute|run-|refresh|sync|delete|reset/i.test(`${route} ${source.slice(0, 2000)}`)) return 'Critical';
  if (mutating && classification !== 'Public') return 'Critical';
  if (/debug|metrics|health|diagnostic|backtest|scan|report|insight/i.test(route)) return 'High';
  return classification === 'Unknown' ? 'Medium' : 'Low';
}

const rows = [];
for (const file of walk(apiRoot).sort()) {
  const source = fs.readFileSync(file, 'utf8');
  const found = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)];
  for (let i = 0; i < found.length; i++) {
    const method = found[i][1];
    const body = source.slice(found[i].index, found[i + 1]?.index ?? source.length);
    const route = routeFor(file);
    const guard = protection(source, body);
    const classification = classify(route, method, guard, source);
    const risk = riskFor(route, method, guard, classification, source);
    const action = risk === 'Critical' ? 'Add/verify server-side authorization before release'
      : risk === 'High' ? 'Review intended exposure; protect or minimize detail'
      : classification === 'Unknown' ? 'Owner approval required to classify intent'
      : 'None';
    rows.push({ method, route, file: path.relative(root, file).split(path.sep).join('/'), guard, classification, risk, action });
  }
}

const count = (predicate) => rows.filter(predicate).length;
const section = (title, predicate) => {
  const matches = rows.filter(predicate);
  return `### ${title} (${matches.length})\n\n${matches.length ? matches.map((r) => `- \`${r.method} ${r.route}\` — ${r.guard}; ${r.risk}`).join('\n') : '- None detected'}\n`;
};
let md = `# API security inventory\n\nGenerated from ${walk(apiRoot).length} route handlers and ${rows.length} exported HTTP methods. Classification is based on server-side handler code; browser proxy cookie presence is not counted as authorization. Heuristic Unknown entries require owner review.\n\n## Summary\n\n| Classification | Methods |\n|---|---:|\n`;
for (const name of ['Public','Authenticated user','Role or permission protected','Admin-only','Internal worker','Internal service','Operational monitoring','Development or debug','Deprecated','Disabled','Unknown']) {
  md += `| ${name} | ${count((r) => r.classification === name)} |\n`;
}
md += `\n| Risk | Methods |\n|---|---:|\n| Critical | ${count((r) => r.risk === 'Critical')} |\n| High | ${count((r) => r.risk === 'High')} |\n| Medium | ${count((r) => r.risk === 'Medium')} |\n| Low | ${count((r) => r.risk === 'Low')} |\n\n`;
md += section('Public mutation endpoints', (r) => r.guard === 'None detected' && !['GET','HEAD','OPTIONS'].includes(r.method));
md += section('Public expensive-computation endpoints', (r) => r.guard === 'None detected' && /backtest|scan|process|report|insight|calibrat/i.test(r.route));
md += section('Public debug endpoints', (r) => r.guard === 'None detected' && /debug|diagnostic|test-|dev/i.test(r.route));
md += section('Public detailed health endpoints', (r) => r.guard === 'None detected' && /health|status|monitor/i.test(r.route));
md += section('Public metrics endpoints', (r) => r.guard === 'None detected' && /metrics/i.test(r.route));
md += section('Queue-processing endpoints', (r) => /queue|process/i.test(r.route));
md += section('Scheduler-trigger endpoints', (r) => /schedul|cron|trigger/i.test(r.route));
md += section('Backtest execution endpoints', (r) => /backtest/i.test(r.route) && /POST|PUT|PATCH|DELETE/.test(r.method));
md += section('Manipulation scan endpoints', (r) => /manipulation.*scan|scan.*manipulation/i.test(r.route));
md += section('Market-data maintenance endpoints', (r) => /market|candle|instrument/i.test(r.route) && /seed|sync|refresh|backfill|migrat/i.test(r.route));
md += `\n## Method inventory\n\n| Method | Route | Handler path | Current protection | Intended classification | Risk | Required action |\n|---|---|---|---|---|---|---|\n`;
for (const r of rows) md += `| ${r.method} | \`${r.route}\` | \`${r.file}\` | ${r.guard} | ${r.classification} | ${r.risk} | ${r.action} |\n`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log(JSON.stringify({ routeHandlers: walk(apiRoot).length, methods: rows.length, critical: count((r) => r.risk === 'Critical'), high: count((r) => r.risk === 'High'), unknown: count((r) => r.classification === 'Unknown') }));
