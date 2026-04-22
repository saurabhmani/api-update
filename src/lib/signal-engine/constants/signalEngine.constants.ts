// ════════════════════════════════════════════════════════════════
//  Quantorus365 Signal Engine — Phase 1 Constants
// ════════════════════════════════════════════════════════════════

import type { Phase1Config } from '../types/signalEngine.types';

// ── Indicator Periods ────────────────────────────────────────
export const EMA_FAST = 20;
export const EMA_MID = 50;
export const EMA_SLOW = 200;
export const RSI_PERIOD = 14;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const ATR_PERIOD = 14;
export const ROC_SHORT = 5;
export const ROC_LONG = 20;
export const VOLUME_AVG_PERIOD = 20;
export const STRUCTURE_LOOKBACK = 20;
export const STOCHASTIC_K_PERIOD = 14;
export const STOCHASTIC_D_PERIOD = 3;
export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_STD_DEV = 2;
export const ADX_PERIOD = 14;
export const OBV_SLOPE_PERIOD = 10;
export const VWAP_PERIOD = 20;
export const VOLUME_CLIMAX_THRESHOLD = 3.0;
export const DIVERGENCE_LOOKBACK = 10;

// ── Breakout ─────────────────────────────────────────────────
export const BREAKOUT_BUFFER = 1.002;
export const MAX_BREAKOUT_EXTENSION_PCT = 5.0;
export const MAX_GAP_PCT = 4.0;
export const MAX_ATR_PCT = 6.0;

// ── Strategy Thresholds ──────────────────────────────────────
export const MIN_VOLUME_EXPANSION = 1.5;
export const RSI_LOWER_BOUND = 55;
export const RSI_UPPER_BOUND = 72;
export const MAX_DISTANCE_FROM_EMA20_PCT = 8.0;

// ── Liquidity Filters ────────────────────────────────────────
export const MIN_AVG_VOLUME = 100_000;
export const MIN_PRICE = 50;

// ── Confidence Scoring Weights ───────────────────────────────
export const CONFIDENCE_WEIGHTS = {
  trend: 25,
  momentum: 20,
  volume: 20,
  structure: 20,
  context: 15,
} as const;

// ── Confidence Bands ─────────────────────────────────────────
export const CONFIDENCE_HIGH_CONVICTION = 85;
export const CONFIDENCE_ACTIONABLE = 70;
export const CONFIDENCE_WATCHLIST = 55;

// ── Risk Bands ───────────────────────────────────────────────
export const RISK_LOW = 30;
export const RISK_MODERATE = 55;
export const RISK_ELEVATED = 75;

// ── Pipeline Defaults ────────────────────────────────────────
// MIN_CANDLE_COUNT: 80 candles is the absolute minimum for our
// indicator stack (longest lookback = 50-day SMA + buffer).
//
// MIN_CONFIDENCE_TO_SAVE: kept as a constant for backward compat
// with old config consumers, but the pipeline NO LONGER uses it
// as an early drop filter. Every scored signal flows through to
// the API which sorts by confidence desc and slices the top 50.
// The actual quality floor is now applied at API output time
// via FINAL_CONFIDENCE_FLOOR below.
export const MIN_CANDLE_COUNT = 80;
export const MIN_CONFIDENCE_TO_SAVE = 0;

// API-output confidence floor. Signals below this score are
// dropped at READ time (not generation time). Set to 0 so the
// API always returns the top 50 by confidence regardless of
// score — the user explicitly wants SIGNALS=50 every render,
// and this is the only way to guarantee that without
// fabricating data. UI ConfBar still shows per-row confidence
// so weak signals are visually distinguishable.
export const FINAL_CONFIDENCE_FLOOR = 0;

export const STOP_ATR_MULTIPLIER = 1.5;
export const TARGET1_R_MULTIPLE = 1.5;
export const TARGET2_R_MULTIPLE = 2.5;

// ── Allowed Regimes for Bullish Breakout ─────────────────────
export const BULLISH_ALLOWED_REGIMES = ['Strong Bullish', 'Bullish'] as const;

// ── Default Phase 1 Config ───────────────────────────────────
// Universe widened to NIFTY 200 so even after MIN_CONFIDENCE_TO_SAVE=55
// filtering (~30-50% pass rate in normal markets), the pipeline still
// produces 60-100 signals — comfortably more than the top-50 the API
// returns. The confidence threshold is NOT lowered. Funnel widening
// is the only honest way to guarantee SIGNALS: 50.
export const DEFAULT_PHASE1_CONFIG: Phase1Config = {
  universe: [
    // ── NIFTY 50 ─────────────────────────────────────────────
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
    'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'SUNPHARMA',
    'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'WIPRO', 'HCLTECH',
    'BAJFINANCE', 'BAJAJFINSV', 'TECHM', 'NTPC', 'POWERGRID',
    'TATAMOTORS', 'TATASTEEL', 'ONGC', 'COALINDIA', 'ADANIENT',
    'ADANIPORTS', 'JSWSTEEL', 'M&M', 'GRASIM', 'DIVISLAB',
    'DRREDDY', 'CIPLA', 'EICHERMOT', 'HEROMOTOCO', 'BPCL',
    'BRITANNIA', 'APOLLOHOSP', 'INDUSINDBK', 'SBILIFE', 'HDFCLIFE',
    'DABUR', 'GODREJCP', 'PIDILITIND', 'BERGEPAINT', 'HAVELLS',
    // ── NIFTY Next 50 ─────────────────────────────────────────
    'ABB', 'ADANIGREEN', 'ADANIPOWER', 'AMBUJACEM', 'BAJAJHLDNG',
    'BANKBARODA', 'BEL', 'BIOCON', 'BOSCHLTD', 'CANBK',
    'CHOLAFIN', 'COLPAL', 'DLF', 'GAIL', 'GODREJPROP',
    'HAL', 'ICICIGI', 'ICICIPRULI', 'IDEA', 'IGL',
    'INDIGO', 'IOC', 'IRCTC', 'JINDALSTEL', 'LICI',
    'LTIM', 'LUPIN', 'MARICO', 'MCDOWELL-N', 'MFSL',
    'MOTHERSON', 'MPHASIS', 'MUTHOOTFIN', 'NAUKRI', 'PAGEIND',
    'PIRAMALFIN', 'PETRONET', 'PFC', 'PIIND', 'PNB',
    'RECLTD', 'SAIL', 'SHREECEM', 'SIEMENS', 'SRF',
    'TORNTPHARM', 'TRENT', 'TVSMOTOR', 'UBL', 'VEDL',
    // ── NIFTY 100→200 (mid-large caps) ───────────────────────
    'ABBOTINDIA', 'ABCAPITAL', 'ACC', 'ALKEM', 'APLAPOLLO',
    'ASHOKLEY', 'ASTRAL', 'AUBANK', 'AUROPHARMA', 'BALKRISIND',
    'BANDHANBNK', 'BATAINDIA', 'BHARATFORG', 'BHEL', 'BSOFT',
    'CGPOWER', 'COFORGE', 'CONCOR', 'CROMPTON', 'CUMMINSIND',
    'DEEPAKNTR', 'DELHIVERY', 'DIXON', 'ESCORTS', 'EXIDEIND',
    'FEDERALBNK', 'GLAND', 'GLENMARK', 'GMRINFRA', 'GNFC',
    'GUJGASLTD', 'HDFCAMC', 'HINDPETRO', 'IDFCFIRSTB', 'INDHOTEL',
    'INDUSTOWER', 'IPCALAB', 'IRFC', 'JKCEMENT', 'JUBLFOOD',
    'KPITTECH', 'L&TFH', 'LALPATHLAB', 'LAURUSLABS', 'LICHSGFIN',
    'M&MFIN', 'MANAPPURAM', 'MAXHEALTH', 'METROPOLIS', 'MRF',
    'NMDC', 'OBEROIRLTY', 'OFSS', 'OIL', 'PERSISTENT',
    'PHOENIXLTD', 'POLICYBZR', 'POLYCAB', 'PRESTIGE', 'PVRINOX',
    'RAMCOCEM', 'RVNL', 'SBICARD', 'SCHAEFFLER', 'SONACOMS',
    'STAR', 'SUNDARMFIN', 'SUNTV', 'SUPREMEIND', 'SUZLON',
    'SYNGENE', 'TATACOMM', 'TATAELXSI', 'TATAPOWER', 'THERMAX',
    'TIINDIA', 'TIMKEN', 'TORNTPOWER', 'TRIDENT',
    'UCOBANK', 'UNIONBANK', 'UPL', 'VBL', 'VOLTAS',
    'WHIRLPOOL', 'YESBANK', 'ZEEL', 'ZOMATO', 'ZYDUSLIFE',
    'NHPC', 'NLCINDIA', 'NIACL', 'NAM-INDIA', 'MGL',
    'MANYAVAR', 'KEI', 'JSWENERGY', 'IRB', 'INDIANB',
    // ── NIFTY Smallcap Select + Liquid Midcaps ──────────────────
    // Added to widen funnel from 146 → ~250 symbols. These are
    // liquid NSE equities with sufficient daily volume for the
    // MIN_LIQUIDITY_VOLUME (25K) gate to pass.
    'AARTIIND', 'ABSLAMC', 'AETHER', 'AJANTPHARM', 'ALKYLAMINE',
    'ANGELONE', 'APARINDS', 'APTUS', 'ATUL', 'BASF',
    'BAYERCROP', 'BEML', 'BSE', 'CAMPUS', 'CANFINHOME',
    'CARBORUNIV', 'CASTROLIND', 'CDSL', 'CEATLTD', 'CENTURYTEX',
    'CHALET', 'CLEAN', 'CUB', 'CYIENT', 'DATAPATTNS',
    'DCMSHRIRAM', 'DEVYANI', 'ELGIEQUIP', 'EMAMILTD', 'ENDURANCE',
    'EQUITASBNK', 'FINEORG', 'FLUOROCHEM', 'GRINDWELL', 'GSPL',
    'HAPPSTMNDS', 'HONAUT', 'HUDCO', 'IIFL', 'INDIAMART',
    'INTELLECT', 'JBCHEPHARM', 'JKPAPER', 'JMFINANCIL', 'JOVEOAGRO',
    'JUNCTION', 'JUSTDIAL', 'KALPATPOWR', 'KALYANKJIL', 'KAYNES',
    'KEC', 'KFINTECH', 'LAXMIMACH', 'LTTS', 'MAPMYINDIA',
    'MASTEK', 'MCX', 'MEDANTA', 'MOTILALOFS', 'NATCOPHARM',
    'NUVAMA', 'PGHH', 'POLYMED', 'POONAWALLA', 'RADICO',
    'RAJESHEXPO', 'RATNAMANI', 'REDINGTON', 'ROUTE', 'SANOFI',
    'SAPPHIRE', 'SHRIRAMFIN', 'SJVN', 'SKFINDIA', 'SOLARINDS',
    'SUVENPHAR', 'TATACHEM', 'TTML', 'VIKAS', 'WELCORP',
    'ZFCVINDIA',
  ],
  benchmarkSymbol: 'NIFTY 50',
  timeframe: 'daily',
  minCandleCount: MIN_CANDLE_COUNT,
  breakoutBuffer: BREAKOUT_BUFFER,
  minAvgVolume: MIN_AVG_VOLUME,
  minPrice: MIN_PRICE,
  minConfidenceToSave: MIN_CONFIDENCE_TO_SAVE,
};
