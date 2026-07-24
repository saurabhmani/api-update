import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  const { db } = await import('../src/lib/db');
  const { parseMysqlUtcDatetime, createBrokerAuthTransaction, consumeBrokerAuthTransaction } = await import('../src/lib/broker/connections/authTransactions');
  const { rows } = await db.query(
    "SELECT id, expires_at, created_at, status FROM broker_auth_transactions WHERE broker=? ORDER BY created_at DESC LIMIT 1",
    ['shoonya'],
  );
  const r = rows[0] as any;
  console.log('typeof', typeof r.expires_at, r.expires_at?.constructor?.name);
  console.log('raw', r.expires_at);
  console.log('String', String(r.expires_at));
  console.log('parsedFromString', parseMysqlUtcDatetime(String(r.expires_at)), 'now', Date.now());
  if (r.expires_at instanceof Date) {
    console.log('date.getTime', r.expires_at.getTime());
    console.log('local parts', r.expires_at.getFullYear(), r.expires_at.getMonth()+1, r.expires_at.getDate(), r.expires_at.getHours(), r.expires_at.getMinutes(), r.expires_at.getSeconds());
  }
  const created = await createBrokerAuthTransaction({ userId: 7, broker: 'shoonya', state: null });
  console.log('created.expiresAt', JSON.stringify(created.transaction.expiresAt));
  const claimed = await consumeBrokerAuthTransaction({ userId: 7, broker: 'shoonya', state: null });
  console.log('claimed', claimed?.id ?? null);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
