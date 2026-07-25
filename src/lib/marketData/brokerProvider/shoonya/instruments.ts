/**
 * Resolve Shoonya exchange tokens via the shared instrument mapper.
 * @deprecated Prefer mapToShoonyaInstrument from ../instruments
 */

import type { NormalizedInstrument, NormalizedInstrumentInput } from '../types';
import type { ShoonyaRestClient } from './restClient';
import {
  mapToShoonyaInstrument,
  type ShoonyaInstrumentMapping,
} from '../instruments/shoonyaMap';

export type ResolvedShoonyaInstrument = {
  symbol: string;
  exchange: string;
  token: string;
};

export async function resolveShoonyaInstrument(
  client: ShoonyaRestClient,
  instrument: NormalizedInstrument | NormalizedInstrumentInput,
): Promise<ResolvedShoonyaInstrument> {
  const mapped: ShoonyaInstrumentMapping = await mapToShoonyaInstrument(instrument, client);
  return {
    symbol: mapped.instrument.symbol,
    exchange: mapped.exchange,
    token: mapped.token,
  };
}
