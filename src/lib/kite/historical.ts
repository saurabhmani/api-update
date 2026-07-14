// ════════════════════════════════════════════════════════════════
//  Kite Connect — historical candle helpers
// ════════════════════════════════════════════════════════════════

import { getKiteClient } from './client';
import { KiteConfigError } from './errors';
import type {
  KiteHistoricalCandle,
  KiteHistoricalInterval,
  KiteHistoricalParams,
} from './types';

export type { KiteHistoricalInterval, KiteHistoricalParams };

const VALID_INTERVALS: ReadonlySet<string> = new Set([
  'minute',
  '3minute',
  '5minute',
  '10minute',
  '15minute',
  '30minute',
  '60minute',
  'day',
]);

function assertInterval(interval: string): asserts interval is KiteHistoricalInterval {
  if (!VALID_INTERVALS.has(interval)) {
    throw new KiteConfigError(
      `Invalid historical interval "${interval}". Expected one of: ${[...VALID_INTERVALS].join(', ')}`,
    );
  }
}

/**
 * Fetch historical candles for an instrument token.
 *
 * Generic wrapper over `KiteConnect.getHistoricalData` — callers own
 * date formatting and interval selection.
 */
export async function getHistoricalData(
  params: KiteHistoricalParams,
): Promise<KiteHistoricalCandle[]> {
  const token = params.instrumentToken;
  if (token === null || token === undefined || token === '') {
    throw new KiteConfigError('instrumentToken is required for historical data');
  }
  assertInterval(params.interval);
  if (!params.from || !params.to) {
    throw new KiteConfigError('from and to are required for historical data');
  }

  const client = getKiteClient();
  const candles = await client.call((kc) =>
    kc.getHistoricalData(
      token,
      params.interval,
      params.from,
      params.to,
      params.continuous ?? false,
      params.oi ?? false,
    ),
  );

  return candles as KiteHistoricalCandle[];
}
