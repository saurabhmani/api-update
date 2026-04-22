// ════════════════════════════════════════════════════════════════
//  Fee Calculator
//
//  Computes all trading costs: commission, STT, stamp duty,
//  exchange charges, GST. Configured per market (India/NSE default).
// ════════════════════════════════════════════════════════════════

export interface FeeConfig {
  /** Flat commission per order (INR) */
  commissionPerOrder: number;
  /** Securities Transaction Tax (% of sell side turnover) */
  sttPct: number;
  /** Exchange transaction charges (% of turnover) */
  exchangeChargePct: number;
  /** Stamp duty (% of buy side turnover) */
  stampDutyPct: number;
  /** GST on commission + exchange charges (%) */
  gstPct: number;
  /** SEBI regulatory charge (% of turnover) */
  sebiChargePct: number;
}

/** Default: Indian equity delivery trading costs */
export const DEFAULT_FEE_CONFIG: FeeConfig = {
  commissionPerOrder: 20,
  sttPct: 0.1,             // 0.1% of sell-side turnover
  exchangeChargePct: 0.00345, // NSE charges
  stampDutyPct: 0.015,     // varies by state, using avg
  gstPct: 18,              // 18% on brokerage + exchange
  sebiChargePct: 0.0001,   // 0.0001% of turnover
};

export interface FeeBreakdown {
  commission: number;
  stt: number;
  exchangeCharges: number;
  stampDuty: number;
  gst: number;
  sebiCharge: number;
  totalFees: number;
}

/**
 * Calculate all fees for a round-trip trade (buy + sell).
 *
 * @param buyValue - Total value of the buy leg
 * @param sellValue - Total value of the sell leg
 * @param config - Fee structure (defaults to Indian equity)
 */
export function calculateTradeFees(
  buyValue: number,
  sellValue: number,
  config: FeeConfig = DEFAULT_FEE_CONFIG,
): FeeBreakdown {
  const totalTurnover = buyValue + sellValue;

  const commission = config.commissionPerOrder * 2; // buy + sell orders
  const stt = (sellValue * config.sttPct) / 100;
  const exchangeCharges = (totalTurnover * config.exchangeChargePct) / 100;
  const stampDuty = (buyValue * config.stampDutyPct) / 100;
  const sebiCharge = (totalTurnover * config.sebiChargePct) / 100;
  const gst = ((commission + exchangeCharges) * config.gstPct) / 100;

  const totalFees = commission + stt + exchangeCharges + stampDuty + gst + sebiCharge;

  return {
    commission: r(commission),
    stt: r(stt),
    exchangeCharges: r(exchangeCharges),
    stampDuty: r(stampDuty),
    gst: r(gst),
    sebiCharge: r(sebiCharge),
    totalFees: r(totalFees),
  };
}

/**
 * Quick fee estimate (simplified: flat commission + percentage).
 */
export function quickFeeEstimate(
  tradeValue: number,
  commissionPerTrade: number,
): number {
  return commissionPerTrade * 2; // entry + exit
}

function r(v: number): number { return Math.round(v * 100) / 100; }
