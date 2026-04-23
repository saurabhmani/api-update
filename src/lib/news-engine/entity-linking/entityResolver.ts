// ════════════════════════════════════════════════════════════════
//  Entity Resolver — news-engine entity linking
//
//  Deterministic entity extraction from news text.
//  Resolves 4 entity types:
//    1. symbol      → NSE stock symbols
//    2. sector      → sector labels (via SECTOR_MAP)
//    3. macro_factor → RBI rate, inflation, GDP, fiscal policy
//    4. commodity   → crude, gold, metals, etc.
//
//  No ML — pure rule-based for speed and determinism.
//  Confidence reflects match quality (exact > alias > keyword).
// ════════════════════════════════════════════════════════════════

import type { EntityLink } from '../types/newsEngine.types';
import { SECTOR_MAP } from '@/lib/signal-engine/constants/phase3.constants';

// ── Symbol dictionaries ──────────────────────────────────────────

// All known NSE symbols from our universe
const KNOWN_SYMBOLS = new Set(Object.keys(SECTOR_MAP));

// Company name → symbol alias map (common references in news).
//
// IMPORTANT: more-specific aliases MUST appear before shorter ones
// that are their prefixes. Example: "adani green" must resolve to
// ADANIGREEN, but the previous version had "adani" → ADANIENT first
// and the loop used `textLower.includes(alias)`, so "Adani Green" was
// tagged as ADANIENT (Adani Enterprises, wrong company). At runtime
// we iterate by descending key length (see resolveEntities) so a
// longer alias always wins over a shorter prefix.
const COMPANY_ALIASES: Record<string, string> = {
  // Reliance
  'reliance industries':  'RELIANCE',
  'reliance':             'RELIANCE',
  // Tata group
  'tata consultancy':     'TCS',
  'tata motors':          'TATAMOTORS',
  'tata steel':           'TATASTEEL',
  'tata power':           'TATAPOWER',
  'tata chemicals':       'TATACHEM',
  'tata consumer':        'TATACONSUM',
  'indian hotels':        'INDHOTEL',
  'titan company':        'TITAN',
  'titan':                'TITAN',
  // IT
  'infosys':              'INFY',
  'hcl technologies':     'HCLTECH',
  'hcl tech':             'HCLTECH',
  'wipro':                'WIPRO',
  'tech mahindra':        'TECHM',
  'ltimindtree':          'LTIM',
  'l&t technology':       'LTTS',
  'persistent systems':   'PERSISTENT',
  'coforge':              'COFORGE',
  'mphasis':              'MPHASIS',
  // Banks + financials
  'hdfc bank':            'HDFCBANK',
  'icici bank':           'ICICIBANK',
  'kotak mahindra':       'KOTAKBANK',
  'kotak bank':           'KOTAKBANK',
  'axis bank':            'AXISBANK',
  'state bank of india':  'SBIN',
  'state bank':           'SBIN',
  'sbi':                  'SBIN',
  'indusind bank':        'INDUSINDBK',
  'bandhan bank':         'BANDHANBNK',
  'bank of baroda':       'BANKBARODA',
  'au small finance':     'AUBANK',
  'idfc first bank':      'IDFCFIRSTB',
  'punjab national bank': 'PNB',
  'canara bank':          'CANBK',
  'federal bank':         'FEDERALBNK',
  'bajaj finance':        'BAJFINANCE',
  'bajaj finserv':        'BAJAJFINSV',
  'bajaj auto':           'BAJAJ_AUTO',
  'cholamandalam':        'CHOLAFIN',
  'shriram finance':      'SHRIRAMFIN',
  'muthoot finance':      'MUTHOOTFIN',
  'sbi life':             'SBILIFE',
  'hdfc life':            'HDFCLIFE',
  'icici prudential':     'ICICIPRULI',
  'icici lombard':        'ICICIGI',
  // Telecom
  'bharti airtel':        'BHARTIARTL',
  'airtel':               'BHARTIARTL',
  'vodafone idea':        'IDEA',
  // FMCG / consumer
  'hindustan unilever':   'HINDUNILVR',
  'hul':                  'HINDUNILVR',
  'itc':                  'ITC',
  'nestle india':         'NESTLEIND',
  'britannia':            'BRITANNIA',
  'dabur':                'DABUR',
  'godrej consumer':      'GODREJCP',
  'marico':               'MARICO',
  'colgate palmolive':    'COLPAL',
  'united spirits':       'MCDOWELL_N',
  'varun beverages':      'VBL',
  'avenue supermarts':    'DMART',
  'dmart':                'DMART',
  'trent limited':        'TRENT',
  // Pharma
  'sun pharmaceutical':   'SUNPHARMA',
  'sun pharma':           'SUNPHARMA',
  "dr reddy's":           'DRREDDY',
  'dr reddy':             'DRREDDY',
  'cipla':                'CIPLA',
  "divi's lab":           'DIVISLAB',
  'divis lab':            'DIVISLAB',
  'lupin':                'LUPIN',
  'aurobindo pharma':     'AUROPHARMA',
  'zydus lifesciences':   'ZYDUSLIFE',
  'torrent pharma':       'TORNTPHARM',
  'alkem laboratories':   'ALKEM',
  'biocon':               'BIOCON',
  'apollo hospitals':     'APOLLOHOSP',
  'fortis healthcare':    'FORTIS',
  'max healthcare':       'MAXHEALTH',
  // Autos
  'maruti suzuki':        'MARUTI',
  'maruti':               'MARUTI',
  'eicher motors':        'EICHERMOT',
  'hero motocorp':        'HEROMOTOCO',
  'mahindra & mahindra':  'M_M',
  'm&m':                  'M_M',
  'ashok leyland':        'ASHOKLEY',
  'motherson sumi':       'MOTHERSON',
  'tvs motor':            'TVSMOTOR',
  // Industrials / infra
  'larsen & toubro':      'LT',
  'l&t':                  'LT',
  'ultratech cement':     'ULTRACEMCO',
  'ultratech':            'ULTRACEMCO',
  'ambuja cement':        'AMBUJACEM',
  'shree cement':         'SHREECEM',
  'asian paints':         'ASIANPAINT',
  'berger paints':        'BERGEPAINT',
  'pidilite':             'PIDILITIND',
  'havells':              'HAVELLS',
  'siemens':              'SIEMENS',
  'abb india':            'ABB',
  'bhel':                 'BHEL',
  'cummins india':        'CUMMINSIND',
  // Power / utilities / energy
  'ntpc':                 'NTPC',
  'power grid':           'POWERGRID',
  'ongc':                 'ONGC',
  'bpcl':                 'BPCL',
  'hpcl':                 'HINDPETRO',
  'ioc':                  'IOC',
  'indian oil':           'IOC',
  'coal india':           'COALINDIA',
  'gail':                 'GAIL',
  'sjvn':                 'SJVN',
  // Adani group — longer forms first in source order (runtime also
  // sorts by length desc, so "adani green" beats "adani" regardless).
  'adani enterprises':    'ADANIENT',
  'adani ports':          'ADANIPORTS',
  'adani green energy':   'ADANIGREEN',
  'adani green':          'ADANIGREEN',
  'adani transmission':   'ADANIENSOL',   // renamed to Adani Energy Solutions
  'adani energy solutions': 'ADANIENSOL',
  'adani total gas':      'ATGL',
  'adani wilmar':         'AWL',
  'adani power':          'ADANIPOWER',
  'adani':                'ADANIENT',
  // Metals
  'jsw steel':            'JSWSTEEL',
  'jsw energy':            'JSWENERGY',
  'hindalco':             'HINDALCO',
  'vedanta':              'VEDL',
  'sail':                 'SAIL',
  'nalco':                'NATIONALUM',
  // New-age / internet
  'zomato':               'ZOMATO',
  'paytm':                'PAYTM',
  'nykaa':                'NYKAA',
  'fsn e-commerce':       'NYKAA',
  'policybazaar':         'POLICYBZR',
  'pb fintech':           'POLICYBZR',
  'delhivery':            'DELHIVERY',
  'mapmyindia':           'MAPMYINDIA',
  'cartrade':             'CARTRADE',
  'easy trip':            'EASEMYTRIP',
  'easemytrip':           'EASEMYTRIP',
  // Diversified / misc common names in press
  'grasim':               'GRASIM',
  'ubl':                  'UBL',
  'united breweries':     'UBL',
  'indigo':               'INDIGO',
  'interglobe aviation':  'INDIGO',
  'spicejet':             'SPICEJET',
  'irctc':                'IRCTC',
  'indian railways':      'IRCTC',
  'lic':                  'LICI',
  'life insurance corporation': 'LICI',
};

// ── Sector keywords ──────────────────────────────────────────────

const SECTOR_KEYWORDS: Record<string, string[]> = {
  IT:           ['it sector', 'technology sector', 'nifty it', 'software', 'outsourcing'],
  Banking:      ['banking sector', 'nifty bank', 'bank nifty', 'private banks', 'psu banks', 'banking stocks'],
  Pharma:       ['pharma sector', 'nifty pharma', 'pharmaceutical', 'drug maker', 'healthcare sector'],
  Auto:         ['auto sector', 'nifty auto', 'automobile', 'ev sector', 'electric vehicle'],
  FMCG:         ['fmcg sector', 'nifty fmcg', 'consumer goods', 'fast moving'],
  Metals:       ['metal sector', 'nifty metal', 'mining', 'steel sector'],
  Energy:       ['energy sector', 'nifty energy', 'oil and gas', 'petroleum'],
  Power:        ['power sector', 'nifty power', 'electricity', 'thermal power', 'renewable energy'],
  Infra:        ['infra sector', 'infrastructure', 'nifty infra', 'construction'],
  NBFC:         ['nbfc', 'non-banking', 'microfinance'],
  Insurance:    ['insurance sector', 'life insurance', 'general insurance'],
  Cement:       ['cement sector', 'cement stocks'],
  Telecom:      ['telecom sector', 'nifty telecom', '5g', 'spectrum'],
  Consumer:     ['consumer durables', 'consumer discretionary', 'retail sector'],
  Healthcare:   ['healthcare', 'hospital sector', 'diagnostics'],
  Conglomerate: ['conglomerate'],
};

// ── Macro factor patterns ────────────────────────────────────────

const MACRO_FACTORS: Array<{ pattern: RegExp; factor: string }> = [
  { pattern: /\b(RBI|reserve bank|repo\s*rate|reverse\s*repo)\b/i, factor: 'rbi_rate' },
  { pattern: /\b(inflation|CPI|consumer\s*price|WPI|wholesale\s*price)\b/i, factor: 'inflation' },
  { pattern: /\b(GDP|gross\s*domestic|economic\s*growth)\b/i, factor: 'gdp_growth' },
  { pattern: /\b(fiscal\s*deficit|government\s*spending|budget)\b/i, factor: 'fiscal_policy' },
  { pattern: /\b(FII|FPI|foreign\s*institutional|DII|domestic\s*institutional)\b/i, factor: 'institutional_flow' },
  { pattern: /\b(rupee|USD.*INR|INR.*USD|dollar.*rupee|forex)\b/i, factor: 'currency_inr_usd' },
  { pattern: /\b(current\s*account|trade\s*deficit|export|import\s*duty)\b/i, factor: 'trade_balance' },
  { pattern: /\b(Fed|Federal\s*Reserve|FOMC|Powell|rate\s*hike|rate\s*cut)\b/i, factor: 'us_fed_policy' },
  { pattern: /\b(China.*slow|China.*growth|China.*economy)\b/i, factor: 'china_economy' },
  { pattern: /\b(election|geopolitic|war|sanction|tariff)\b/i, factor: 'geopolitical' },
];

// ── Commodity patterns ───────────────────────────────────────────

const COMMODITY_PATTERNS: Array<{ pattern: RegExp; commodity: string }> = [
  { pattern: /\b(crude\s*oil|Brent|WTI|oil\s*price)\b/i, commodity: 'crude_oil' },
  { pattern: /\b(gold\s*price|gold\s*rate|yellow\s*metal|MCX\s*gold)\b/i, commodity: 'gold' },
  { pattern: /\b(silver\s*price|silver\s*rate|MCX\s*silver)\b/i, commodity: 'silver' },
  { pattern: /\b(copper\s*price|MCX\s*copper)\b/i, commodity: 'copper' },
  { pattern: /\b(aluminium|aluminum)\b/i, commodity: 'aluminium' },
  { pattern: /\b(steel\s*price|HRC|hot\s*rolled)\b/i, commodity: 'steel' },
  { pattern: /\b(natural\s*gas|LNG)\b/i, commodity: 'natural_gas' },
  { pattern: /\b(coal\s*price|thermal\s*coal)\b/i, commodity: 'coal' },
];

// ── Main Entity Resolver ─────────────────────────────────────────

export function resolveEntities(
  title: string,
  body: string | null,
  rawMeta?: Record<string, unknown>,
): EntityLink[] {
  const text = `${title} ${body ?? ''}`;
  const textLower = text.toLowerCase();
  const entities: EntityLink[] = [];
  const seen = new Set<string>();

  function add(link: EntityLink) {
    const key = `${link.entityType}:${link.entityValue}`;
    if (seen.has(key)) return;
    seen.add(key);
    entities.push(link);
  }

  // ── 1. Symbol resolution: exact match ──────────────────────
  // Check for NSE symbols as whole words in the text
  for (const symbol of KNOWN_SYMBOLS) {
    // Match the symbol as a whole word (handles TCS, INFY etc.)
    const regex = new RegExp(`\\b${symbol.replace(/_/g, '[_&]')}\\b`, 'i');
    if (regex.test(text)) {
      add({
        entityType: 'symbol',
        entityValue: symbol,
        confidence: 90,
        matchMethod: 'exact',
      });
    }
  }

  // ── 2. Symbol resolution: alias match (WORD-BOUNDARY) ──────
  // Iterate longest aliases first and consume (blank out) matched
  // substrings in a working copy. Prevents "Adani Green Energy" from
  // double-matching as both ADANIGREEN and ADANIENT (via the shorter
  // "adani" alias) — the longer, more-specific match wins.
  //
  // IMPORTANT: matches MUST be whole words. The previous
  // `.includes(alias)` substring test attached NSE tickers to wholly
  // unrelated US/global news — e.g. `'lic'` → LICI triggered on any
  // article mentioning "conflict" / "public" / "policy" because they
  // contain the letters "lic". We now require a word boundary on both
  // sides so the matcher only fires on genuine company mentions.
  function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const aliasesByLength = Object.entries(COMPANY_ALIASES).sort(
    (a, b) => b[0].length - a[0].length,
  );
  let textWorking = textLower;
  for (const [alias, symbol] of aliasesByLength) {
    const re = new RegExp(`\\b${escapeRe(alias)}\\b`, 'g');
    if (re.test(textWorking)) {
      add({
        entityType: 'symbol',
        entityValue: symbol,
        confidence: 80,
        matchMethod: 'alias',
      });
      // Blank out every occurrence so a shorter prefix in the same
      // span can't match again.
      textWorking = textWorking.replace(
        new RegExp(`\\b${escapeRe(alias)}\\b`, 'g'),
        ' '.repeat(alias.length),
      );
    }
  }

  // ── 3. Symbol resolution: Finnhub related field ────────────
  if (rawMeta?.related && typeof rawMeta.related === 'string') {
    const related = (rawMeta.related as string).split(',').map((s) => s.trim().toUpperCase());
    for (const sym of related) {
      if (KNOWN_SYMBOLS.has(sym)) {
        add({
          entityType: 'symbol',
          entityValue: sym,
          confidence: 85,
          matchMethod: 'exact',
        });
      }
    }
  }

  // ── 4. Sector resolution ───────────────────────────────────
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    for (const kw of keywords) {
      if (textLower.includes(kw)) {
        add({
          entityType: 'sector',
          entityValue: sector,
          confidence: 75,
          matchMethod: 'keyword',
        });
        break;
      }
    }
  }

  // Infer sector from resolved symbols
  for (const e of entities.filter((e) => e.entityType === 'symbol')) {
    const sector = SECTOR_MAP[e.entityValue];
    if (sector) {
      add({
        entityType: 'sector',
        entityValue: sector,
        confidence: 70,
        matchMethod: 'sector_infer',
      });
    }
  }

  // ── 5. Macro factor resolution ─────────────────────────────
  for (const { pattern, factor } of MACRO_FACTORS) {
    if (pattern.test(text)) {
      add({
        entityType: 'macro_factor',
        entityValue: factor,
        confidence: 80,
        matchMethod: 'keyword',
      });
    }
  }

  // ── 6. Commodity resolution ────────────────────────────────
  for (const { pattern, commodity } of COMMODITY_PATTERNS) {
    if (pattern.test(text)) {
      add({
        entityType: 'commodity',
        entityValue: commodity,
        confidence: 80,
        matchMethod: 'keyword',
      });
    }
  }

  return entities;
}
