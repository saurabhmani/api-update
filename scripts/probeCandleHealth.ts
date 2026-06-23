import { db } from '../src/lib/db';
import { getMarketStatus } from '../src/lib/marketData/marketHours';
import { classifyCandleFreshness } from '../src/lib/marketData/candleFreshness';
import { probeEngineHealthStatus } from '../src/lib/monitor/engineHealthProbe';
import { buildLightweightEngineHealthPreview } from '../src/lib/signals/engineHealthMap';

async function main() {
  const market = getMarketStatus();
  let latestMs: number | null = null;
  try {
    const r = await db.query('SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily');
    const ts = (r.rows[0] as { ts?: number | string | null })?.ts;
    if (ts != null) latestMs = Number(ts) * 1000;
  } catch (e) {
    console.error('db err', e);
  }

  const ageHours = latestMs ? (Date.now() - latestMs) / 3_600_000 : null;
  const report = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open:      market.isOpen,
    candle_source:    'daily',
  });

  const ageMinutes = ageHours != null ? Math.round(ageHours * 60) : null;
  const preview = buildLightweightEngineHealthPreview({
    marketOpen:       market.isOpen,
    isBootstrap:      false,
    isFallback:       false,
    staleMinutes:     ageMinutes,
    freshnessMode:    report.freshness_mode,
    feedFrozen:       report.feed_frozen,
    freshnessQuality: report.freshness_quality,
    approvedTotal:    0,
    candidateTotal:   5,
  });

  const probe = await probeEngineHealthStatus();

  console.log(JSON.stringify({
    market,
    latestIso:  latestMs ? new Date(latestMs).toISOString() : null,
    ageHours:   ageHours?.toFixed(1) ?? null,
    candleReport: report,
    healthPreview: preview,
    institutionalProbe: probe,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
