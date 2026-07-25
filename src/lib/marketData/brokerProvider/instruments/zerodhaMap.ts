/**
 * NormalizedInstrument → Zerodha instrument_token.
 * Never reads or returns a Shoonya exchange token.
 */

import { getInstrumentBySymbol } from '@/lib/kite/instruments';
import type { NormalizedInstrument, NormalizedInstrumentInput } from '../types';
import { BrokerMarketDataError } from '../types';
import { getMasterRow } from './masterCache';
import { normalizeInstrument, toKiteInstrumentKey } from './normalize';

export interface ZerodhaInstrumentMapping {
  instrument: NormalizedInstrument;
  /** Kite instrument_token only */
  instrumentToken: number;
  kiteKey: string;
}

export async function mapToZerodhaInstrument(
  input: NormalizedInstrumentInput | NormalizedInstrument,
): Promise<ZerodhaInstrumentMapping> {
  const instrument = normalizeInstrument(input, 'zerodha');
  const master = getMasterRow(instrument.instrumentKey);
  if (master?.zerodhaInstrumentToken) {
    return {
      instrument: {
        ...instrument,
        name: instrument.name ?? master.name,
      },
      instrumentToken: master.zerodhaInstrumentToken,
      kiteKey: toKiteInstrumentKey(instrument.exchange, instrument.symbol),
    };
  }

  // Fall back to Kite instruments dump / active cache (supports BSE / INDEX / NFO when available).
  const kiteInst = await getInstrumentBySymbol(instrument.symbol, instrument.exchange);
  const token = Number(kiteInst?.instrument_token);
  if (!Number.isFinite(token) || token <= 0) {
    throw new BrokerMarketDataError(
      'zerodha',
      'instrument_unresolved',
      `No Zerodha instrument_token for ${instrument.instrumentKey}`,
    );
  }

  // Guard: never confuse with exchange_token magnitudes accidentally passed as instrument.
  if (
    master
    && String(token) === master.shoonyaExchangeToken
    && token !== master.zerodhaInstrumentToken
  ) {
    throw new BrokerMarketDataError(
      'zerodha',
      'instrument_unresolved',
      `Refusing Shoonya exchange_token as Zerodha mapping for ${instrument.instrumentKey}`,
    );
  }

  return {
    instrument: {
      ...instrument,
      name: instrument.name ?? kiteInst?.name ?? null,
    },
    instrumentToken: token,
    kiteKey: toKiteInstrumentKey(instrument.exchange, instrument.symbol),
  };
}

export async function mapManyToZerodha(
  inputs: Array<NormalizedInstrumentInput | NormalizedInstrument>,
): Promise<{ mapped: ZerodhaInstrumentMapping[]; failed: string[] }> {
  const mapped: ZerodhaInstrumentMapping[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    try {
      const row = await mapToZerodhaInstrument(input);
      if (seen.has(row.instrument.instrumentKey)) continue;
      seen.add(row.instrument.instrumentKey);
      mapped.push(row);
    } catch {
      const key =
        'instrumentKey' in input && input.instrumentKey
          ? String(input.instrumentKey)
          : `${input.exchange ?? '?'}:${input.symbol ?? '?'}`;
      failed.push(key);
    }
  }
  return { mapped, failed };
}
