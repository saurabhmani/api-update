#!/usr/bin/env node
// Quick-and-dirty complexity audit for src/. Naive, not AST-based —
// flags hotspots for follow-up review. Run from repo root:
//   node scripts/complexityAudit.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = 'src';
const MIN_LINES_TO_REPORT = 25;
const BIG_FN_THRESHOLD = 100;

const fnDeclRe = /^[\t ]*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const arrowFnRe = /^[\t ]*(?:export\s+)?const\s+(\w+)\s*[:=].*=>\s*\{\s*$/;
const branchTokens = /\bif\b|\bfor\b|\bwhile\b|\bcase\b|\?\s|&&|\|\|/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT, [])) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(fnDeclRe) || lines[i].match(arrowFnRe);
    if (!m) continue;
    const name = m[1];
    let depth = 0;
    let started = false;
    let endIdx = -1;
    let body = '';
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') {
          depth--;
          if (started && depth === 0) { endIdx = j; break; }
        }
      }
      body += lines[j] + '\n';
      if (endIdx !== -1) break;
    }
    if (endIdx < 0) continue;
    const nLines = endIdx - i + 1;
    if (nLines < MIN_LINES_TO_REPORT) continue;
    const cc = 1 + (body.match(branchTokens) || []).length;
    findings.push({
      file: file.replace(/\\/g, '/'),
      name,
      startLine: i + 1,
      lines: nLines,
      cc,
    });
    i = endIdx;
  }
}

function fmt(rows, kind) {
  console.log(`\n=== TOP-15 by ${kind} ===`);
  console.log('lines   cc   file:line  name');
  console.log('-----   --   ------------------------------------------------');
  for (const r of rows.slice(0, 15)) {
    console.log(
      String(r.lines).padStart(5) + '   ' +
      String(r.cc).padStart(2)   + '   ' +
      r.file + ':' + r.startLine + '  ' + r.name,
    );
  }
}

const byLines = [...findings].sort((a, b) => b.lines - a.lines);
fmt(byLines, 'LINE COUNT (functions ≥ 25 lines)');

const byCc = [...findings].sort((a, b) => b.cc - a.cc);
fmt(byCc, 'CYCLOMATIC COMPLEXITY (proxy)');

const big = byLines.filter((r) => r.lines > BIG_FN_THRESHOLD);
console.log('\n=== FUNCTIONS over ' + BIG_FN_THRESHOLD + ' lines: ' + big.length + ' ===');
console.log('lines   cc   file:line  name');
console.log('-----   --   ------------------------------------------------');
for (const r of big) {
  console.log(
    String(r.lines).padStart(5) + '   ' +
    String(r.cc).padStart(2)   + '   ' +
    r.file + ':' + r.startLine + '  ' + r.name,
  );
}

// Duplicate-logic candidate: function names that occur in 2+ files
const byName = new Map();
for (const r of findings) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}
const dups = [...byName.entries()]
  .filter(([, list]) => list.length >= 2 && list[0].name !== '')
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 20);
console.log('\n=== DUPLICATE-NAME CANDIDATES (same function name, multiple files) ===');
for (const [name, list] of dups) {
  console.log(name + '  ×' + list.length);
  for (const r of list) {
    console.log('   ' + r.file + ':' + r.startLine + '  (' + r.lines + ' lines, cc=' + r.cc + ')');
  }
}
