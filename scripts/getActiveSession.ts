import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
import { db } from '../src/lib/db';
(async () => {
  const r = await db.query<any>(`SELECT token FROM user_sessions WHERE expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`);
  console.log(r.rows[0]?.token ?? 'no-active-session');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
