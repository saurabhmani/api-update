// Detector: spoof PROXY. True spoof detection requires per-tick order
// book history. We can only confirm spoofing when orderbookSnapshots
// are present. Without them this detector emits a soft proxy from
// extreme intraday range vs. tiny net change (whip pattern) and is
// EXPLICITLY labelled "proxy".
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const spoofProxyDetector: DetectorFn = ({ current, advanced }): DetectorResult => {
  const ob = advanced?.orderbookSnapshots;

  // Path 1 — real orderbook data available: count rapid layering/cancel.
  if (ob && ob.length > 0) {
    let layeringEvents = 0;
    for (let i = 1; i < ob.length; i++) {
      const prev = ob[i - 1];
      const curr = ob[i];
      // Count a "flip" when the top-level size on either side disappears
      // (>80% reduction) within consecutive snapshots.
      const prevTopBid = prev.bidLevels[0]?.size ?? 0;
      const currTopBid = curr.bidLevels[0]?.size ?? 0;
      const prevTopAsk = prev.askLevels[0]?.size ?? 0;
      const currTopAsk = curr.askLevels[0]?.size ?? 0;
      if (prevTopBid > 0 && currTopBid / prevTopBid < 0.2) layeringEvents++;
      if (prevTopAsk > 0 && currTopAsk / prevTopAsk < 0.2) layeringEvents++;
    }

    const triggered = layeringEvents >= THRESHOLDS.SPOOF_DEPTH_FLIP_MIN;
    return {
      detectorName: 'spoofProxy',
      eventType: 'operator_style_price_lifting',
      triggered,
      detectorScore: triggered ? Math.min(80, 40 + layeringEvents * 4) : 0,
      detectorLabel: triggered
        ? `Spoof-like layering — ${layeringEvents} top-of-book flips (orderbook-derived)`
        : 'No spoof-like layering',
      severity: triggered ? (layeringEvents >= 12 ? 'high' : 'medium') : 'low',
      confidence: triggered ? 0.7 : 0.15,
      evidence: [
        { key: 'layeringEvents', value: layeringEvents, description: 'Top-of-book size flips' },
        { key: 'snapshots', value: ob.length, description: 'Orderbook snapshots evaluated' },
        { key: 'source', value: 'orderbook', description: 'Real depth data used' },
      ],
    };
  }

  // Path 2 — no orderbook: emit a SOFT proxy from daily whip pattern.
  // Wide true range with tiny net change is a weak hint, never confirmation.
  const wideRange = current.trueRangePct >= THRESHOLDS.ABNORMAL_RANGE_PCT;
  const tinyNet = Math.abs(current.return1d) <= 1;
  const triggered = wideRange && tinyNet;

  return {
    detectorName: 'spoofProxy',
    eventType: 'operator_style_price_lifting',
    triggered,
    detectorScore: triggered ? 35 : 0,
    detectorLabel: triggered
      ? 'Whip-pattern proxy — wide range, tiny net move (proxy only, no orderbook data)'
      : 'No spoof proxy',
    severity: 'low',
    confidence: triggered ? 0.3 : 0.1,
    evidence: [
      { key: 'trueRangePct', value: current.trueRangePct, description: 'Today TR%' },
      { key: 'return1d', value: current.return1d, description: 'Today net return %' },
      { key: 'source', value: 'ohlcv-proxy', description: 'No orderbook available — soft proxy only' },
    ],
  };
};
