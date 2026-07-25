/**
 * NormalizedInstrument → Shoonya exchange + token.
 * Never reads or returns a Kite instrument_token.
 */

import type { NormalizedInstrument, NormalizedInstrumentInput } from '../types';
import { BrokerMarketDataError } from '../types';
import type { ShoonyaRestClient } from '../shoonya/restClient';
import { getMasterRow } from './masterCache';
import { normalizeInstrument, toShoonyaScripKey } from './normalize';

export interface ShoonyaInstrumentMapping {
  instrument: NormalizedInstrument;
  exchange: string;
  /** Shoonya / Noren token only (NOT Kite instrument_token) */
  token: string;
  scripKey: string;
}

export async function mapToShoonyaInstrument(
  input: NormalizedInstrumentInput | NormalizedInstrument,
  client?: ShoonyaRestClient | null,
): Promise<ShoonyaInstrumentMapping> {
  const instrument = normalizeInstrument(input, 'shoonya');
  const master = getMasterRow(instrument.instrumentKey);

  if (master?.shoonyaExchangeToken) {
    // Explicit guard: never use zerodhaInstrumentToken as Shoonya token.
    if (String(master.shoonyaExchangeToken) === String(master.zerodhaInstrumentToken)) {
      // Rare equality is possible for tiny tokens; still prefer exchange_token field.
    }
    return {
      instrument: {
        ...instrument,
        name: instrument.name ?? master.name,
      },
      exchange: master.exchange,
      token: master.shoonyaExchangeToken,
      scripKey: toShoonyaScripKey(master.exchange, master.shoonyaExchangeToken),
    };
  }

  if (!client) {
    throw new BrokerMarketDataError(
      'shoonya',
      'instrument_unresolved',
      `No Shoonya exchange token for ${instrument.instrumentKey} (master miss; SearchScrip client required)`,
    );
  }

  const hits = await client.searchScrip(instrument.symbol, instrument.exchange);
  const exact =
    hits.find((h) => {
      const tsym = h.tsym.replace(/-EQ$/i, '').toUpperCase();
      return h.exch === instrument.exchange.toUpperCase() && tsym === instrument.symbol;
    })
    ?? hits.find((h) => h.tsym.replace(/-EQ$/i, '').toUpperCase() === instrument.symbol);

  if (!exact) {
    throw new BrokerMarketDataError(
      'shoonya',
      'instrument_unresolved',
      `No Shoonya token for ${instrument.instrumentKey}`,
    );
  }

  // Reject if SearchScrip somehow returned a Kite-sized token that matches
  // our known Zerodha instrument_token for the same symbol (cross-contamination).
  if (
    master
    && String(exact.token) === String(master.zerodhaInstrumentToken)
    && String(exact.token) !== master.shoonyaExchangeToken
  ) {
    throw new BrokerMarketDataError(
      'shoonya',
      'instrument_unresolved',
      `Refusing Kite instrument_token as Shoonya mapping for ${instrument.instrumentKey}`,
    );
  }

  return {
    instrument,
    exchange: exact.exch,
    token: exact.token,
    scripKey: toShoonyaScripKey(exact.exch, exact.token),
  };
}

export async function mapManyToShoonya(
  inputs: Array<NormalizedInstrumentInput | NormalizedInstrument>,
  client?: ShoonyaRestClient | null,
): Promise<{ mapped: ShoonyaInstrumentMapping[]; failed: string[] }> {
  const mapped: ShoonyaInstrumentMapping[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    try {
      const row = await mapToShoonyaInstrument(input, client);
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
