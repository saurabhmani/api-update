// ════════════════════════════════════════════════════════════════
//  Entry Simulator — Configurable Entry Modes
//
//  Supports 4 entry models that determine WHEN and WHERE a
//  pending signal gets filled on a given bar.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { PendingSignal, TradeDirection } from '../types';
import { applySlippage } from '../utils/slippage';

export type EntryMode =
  | 'same_bar_close'         // Fill at close of the signal bar (immediate)
  | 'next_bar_open'          // Fill at open of the next bar
  | 'next_bar_confirmation'  // Fill only if next bar confirms direction
  | 'within_entry_zone';     // Fill only if price enters the entry zone

export interface EntrySimResult {
  triggered: boolean;
  fillPrice: number;
  slippageCost: number;
  fillMode: EntryMode;
  /** Why entry didn't trigger */
  rejectionReason: string | null;
}

/**
 * Simulate entry for a pending signal on a given bar.
 *
 * @param signal - The pending signal awaiting entry
 * @param candle - Current bar's OHLCV data
 * @param mode - Entry assumption model
 * @param slippageBps - Slippage in basis points
 * @param isSignalBar - Is this the bar the signal was generated on?
 */
export function simulateEntry(
  signal: PendingSignal,
  candle: Candle,
  mode: EntryMode,
  slippageBps: number,
  isSignalBar: boolean = false,
): EntrySimResult {
  const noEntry = (reason: string): EntrySimResult => ({
    triggered: false, fillPrice: 0, slippageCost: 0, fillMode: mode, rejectionReason: reason,
  });

  switch (mode) {
    case 'same_bar_close': {
      // Only valid on the signal bar itself
      if (!isSignalBar) return noEntry('Not signal bar — same_bar_close only applies on signal day');
      const { price, cost } = applySlippage(candle.close, signal.direction, slippageBps);
      return { triggered: true, fillPrice: price, slippageCost: cost, fillMode: mode, rejectionReason: null };
    }

    case 'next_bar_open': {
      // Fill at open of the next bar (signal bar + 1)
      if (isSignalBar) return noEntry('Waiting for next bar open');
      const { price, cost } = applySlippage(candle.open, signal.direction, slippageBps);
      return { triggered: true, fillPrice: price, slippageCost: cost, fillMode: mode, rejectionReason: null };
    }

    case 'next_bar_confirmation': {
      // Fill only if next bar confirms direction
      if (isSignalBar) return noEntry('Waiting for confirmation bar');
      if (signal.direction === 'long') {
        // Confirm: bar closes above entry zone low (bullish follow-through)
        if (candle.close < signal.entryZoneLow) {
          return noEntry(`No bullish confirmation: close ${candle.close} < zone ${signal.entryZoneLow}`);
        }
        const rawFill = Math.max(candle.open, signal.entryZoneLow);
        const { price, cost } = applySlippage(rawFill, 'long', slippageBps);
        return { triggered: true, fillPrice: price, slippageCost: cost, fillMode: mode, rejectionReason: null };
      } else {
        // Short confirm: bar closes below entry zone high
        if (candle.close > signal.entryZoneHigh) {
          return noEntry(`No bearish confirmation: close ${candle.close} > zone ${signal.entryZoneHigh}`);
        }
        const rawFill = Math.min(candle.open, signal.entryZoneHigh);
        const { price, cost } = applySlippage(rawFill, 'short', slippageBps);
        return { triggered: true, fillPrice: price, slippageCost: cost, fillMode: mode, rejectionReason: null };
      }
    }

    case 'within_entry_zone': {
      // Fill only if price trades within the entry zone during the bar
      if (isSignalBar) return noEntry('Waiting for entry zone trigger');
      if (signal.direction === 'long') {
        // Price must trade at or below entryZoneHigh
        if (candle.low > signal.entryZoneHigh) {
          return noEntry(`Price never reached entry zone: low ${candle.low} > ${signal.entryZoneHigh}`);
        }
        const rawFill = Math.min(candle.open, signal.entryZoneHigh);
        const { price, cost } = applySlippage(rawFill, 'long', slippageBps);
        return { triggered: true, fillPrice: price, slippageCost: cost, fillMode: mode, rejectionReason: null };
      } else {
        if (candle.high < signal.entryZoneLow) {
          return noEntry(`Price never reached entry zone: high ${candle.high} < ${signal.entryZoneLow}`);
        }
        const rawFill = Math.max(candle.open, signal.entryZoneLow);
        const { price, cost } = applySlippage(rawFill, 'short', slippageBps);
        return { triggered: true, fillPrice: price, slippageCost: cost, fillMode: mode, rejectionReason: null };
      }
    }
  }
}
