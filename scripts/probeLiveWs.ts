import path from 'path';
import { config as loadEnv } from 'dotenv';
import WebSocket from 'ws';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

async function probeResolver() {
  const { resolveBatch } = await import('../src/lib/marketData/resolver/marketDataResolver');
  const syms = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'SBIN'];
  const r = await resolveBatch(syms, { quiet: false });
  console.log('\n=== resolveBatch (5 liquid symbols) ===');
  console.log('status:', r.status, 'provider:', r.provider, 'coverage:', r.coveragePercent);
  console.log('error:', r.errorCode, r.errorMessage ?? '');
  for (const s of syms) {
    const row = r.data?.[`NSE:${s}`];
    console.log(
      s,
      row ? { ltp: row.ltp, source: row.source, ts: row.timestamp } : 'MISSING',
    );
  }
}

async function probeBaseline() {
  const { getBaselineSymbols, refreshLiveFeedBaseline } = await import(
    '../src/lib/marketData/liveFeedBaseline'
  );
  await refreshLiveFeedBaseline(true);
  const base = getBaselineSymbols();
  console.log('\n=== baseline symbols ===');
  console.log('count:', base.length);
  console.log('sample:', base.slice(0, 10).join(', '));

  if (base.length > 0) {
    const { resolveBatch } = await import('../src/lib/marketData/resolver/marketDataResolver');
    const sample = base.slice(0, 5);
    const r = await resolveBatch(sample, { quiet: true });
    let hits = 0;
    for (const s of sample) {
      const row = r.data?.[`NSE:${s}`];
      if (row && Number.isFinite(row.ltp) && row.ltp > 0) hits++;
    }
    console.log('baseline sample resolve hits:', hits, '/', sample.length);
  }
}

async function probeWs(port = Number(process.env.STREAM_WS_PORT) || 3001) {
  console.log(`\n=== WebSocket ws://localhost:${port} (10s) ===`);
  return new Promise<void>((resolve) => {
    let ticks = 0;
    let prices = 0;
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => {
      console.log('tick frames:', ticks, 'prices frames:', prices);
      ws.close();
      resolve();
    }, 10_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', symbols: [] }));
      console.log('connected (receive-all mode)');
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'tick') {
          ticks++;
          if (ticks <= 2) console.log('tick:', m.data?.symbol, m.data?.price);
        }
        if (m.type === 'prices' || m.type === 'FULL_UPDATE') {
          prices++;
          if (prices <= 2 && Array.isArray(m.data) && m.data[0]) {
            console.log(m.type + ':', m.data[0].symbol, m.data[0].price);
          }
        }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => console.error('ws error:', e.message));
    ws.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

(async () => {
  await probeResolver();
  await probeBaseline();
  await probeWs();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
