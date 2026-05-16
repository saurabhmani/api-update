/// <reference types="node" />
import path from 'path';
import { config } from 'dotenv';
config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
import { db } from '../src/lib/db';

async function main() {
  const cols = await db.query<{ COLUMN_NAME: string; DATA_TYPE: string }>(`
    SELECT COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'
    ORDER BY ORDINAL_POSITION
  `);
  const present = new Set(cols.rows.map(r => r.COLUMN_NAME));
  console.log('Columns present:', cols.rows.length);

  // Phase-9 spec field list
  const SPEC_FIELDS = [
    'symbol', 'yahoo_symbol', 'strategy', 'decision',
    'final_score', 'classification', 'confidence_score',
    'risk_score', 'risk_reward', 'entry_price', 'stop_loss',
    'target1', 'target2', 'factor_scores', 'rejection_reasons',
    'signal_status', 'market_stance', 'scenario_tag',
    'generated_at', 'expires_at', 'source',
  ];
  console.log('\nPhase-9 field audit:');
  for (const f of SPEC_FIELDS) {
    const hit = present.has(f);
    const candidate = hit ? f
      : f === 'strategy'          ? 'signal_type'
      : f === 'factor_scores'     ? 'factor_scores_json'
      : f === 'rejection_reasons' ? 'rejection_reasons_json'
      : f === 'source'            ? 'generation_source'
      : null;
    console.log(`  ${f.padEnd(20)} ${hit ? 'PRESENT' : (candidate ? `MAPPED → ${candidate}` : 'MISSING')}`);
  }

  // Sample latest scanner row population
  const sample = await db.query<Record<string, unknown>>(`
    SELECT signal_type, scenario_tag, market_stance, expires_at, generation_source,
           classification, signal_status, portfolio_fit_score, stress_survival_score
    FROM q365_signals
    WHERE generation_source='scanner:custom-universe:yahoo'
    ORDER BY id DESC LIMIT 3
  `);
  console.log('\nLatest 3 scanner rows (population check):');
  for (const r of sample.rows) console.log('  ', r);

  // Distinct signal_type values from scanner — are we getting the 4 spec strategies?
  const types = await db.query<{ signal_type: string; cnt: number }>(`
    SELECT signal_type, COUNT(*) AS cnt
    FROM q365_signals
    WHERE generation_source='scanner:custom-universe:yahoo'
    GROUP BY signal_type
    ORDER BY cnt DESC
  `);
  console.log('\nDistinct signal_type values from scanner:');
  for (const t of types.rows) console.log('  ', t.signal_type, '×', t.cnt);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
