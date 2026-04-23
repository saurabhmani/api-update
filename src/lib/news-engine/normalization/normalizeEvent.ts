// ════════════════════════════════════════════════════════════════
//  News Normalization Layer
//
//  Transforms RawNewsItem → NewsEvent:
//  - Generates deterministic dedup hash
//  - Classifies category from title/body keywords
//  - Computes rule-based sentiment score
//  - Ensures all fields are structured before downstream use
// ════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import type {
  RawNewsItem,
  NewsEvent,
  NewsCategory,
  SentimentLabel,
} from '../types/newsEngine.types';
import { resolveEntities } from '../entity-linking/entityResolver';

// ── Dedup Hash ───────────────────────────────────────────────────

function computeDedupHash(item: RawNewsItem): string {
  const normalized = (item.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const payload = `${item.sourceId}|${normalized}`;
  return createHash('sha256').update(payload).digest('hex');
}

// ── Category Classification ──────────────────────────────────────

const CATEGORY_RULES: Array<{ pattern: RegExp; category: NewsCategory }> = [
  { pattern: /\b(earnings|quarterly results?|Q[1-4]\s*(FY)?|profit|revenue|net income|EPS|PAT)\b/i, category: 'earnings' },
  { pattern: /\b(merg|acqui|takeover|buyout|deal\s+value|stake\s+sale)\b/i, category: 'merger_acquisition' },
  { pattern: /\b(SEBI|regulator|compliance|penalty|ban|fine|show.?cause)\b/i, category: 'regulatory' },
  { pattern: /\b(RBI|repo\s+rate|CRR|SLR|monetary\s+policy|inflation|GDP|fiscal|budget|tax\s+reform)\b/i, category: 'macro_policy' },
  { pattern: /\b(crude|gold|silver|copper|aluminium|steel|commodity|Brent|WTI|natural\s+gas)\b/i, category: 'commodity' },
  { pattern: /\b(sector.*rotat|sector.*rally|Nifty\s+(IT|Bank|Pharma|Auto|Metal|Realty|FMCG)|sectoral)\b/i, category: 'sector_move' },
  { pattern: /\b(CEO|MD|chairman|appoint|resign|management\s+change|board\s+reshuffle)\b/i, category: 'management_change' },
  { pattern: /\b(insider|promoter|bulk\s+deal|block\s+deal|stake\s+increase|stake\s+decrease)\b/i, category: 'insider_trade' },
  { pattern: /\b(rating|upgrade|downgrade|CRISIL|ICRA|CARE|Moody|Fitch|S&P)\b/i, category: 'credit_rating' },
  { pattern: /\b(IPO|listing|grey\s+market|GMP|public\s+offer|FPO)\b/i, category: 'ipo_listing' },
  { pattern: /\b(Fed|ECB|Powell|Yellen|tariff|geopolitical|China|US\s+market|Wall\s+Street|Dow|Nasdaq|S&P\s+500)\b/i, category: 'global_cue' },
  { pattern: /\b(dividend|split|buyback|bonus|rights\s+issue|record\s+date)\b/i, category: 'corporate_action' },
];

// Title-leading markers for stories whose PRIMARY subject is a
// global/macro event. An article titled "US stocks today: …" is a
// macro piece even if the body mentions "earnings" or a specific
// ticker — classifying it as `earnings` (and attaching NSE symbols)
// was the source of false-positive symbol tags on global news.
const TITLE_GLOBAL_CUE_RE =
  /^\s*(US\s+stocks?|Wall\s+Street|Dow|Nasdaq|S&P\s*500|Asian\s+markets?|European\s+markets?|Global\s+markets?|World\s+markets?)\b/i;

function classifyCategory(title: string, body: string | null): NewsCategory {
  // 1. Strong title-leading check — wins before any substring rule.
  if (TITLE_GLOBAL_CUE_RE.test(title)) return 'global_cue';

  const text = `${title} ${body ?? ''}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return 'general';
}

// ── Sentiment Scoring ────────────────────────────────────────────
// Rule-based sentiment. Two-pass design:
//   1. Phrase pass — matches multi-word expressions that a single-word
//      tokenizer cannot resolve. "profit fall", "sell-off", "miss
//      estimates", "buy recommendation" are the exact cases the user
//      reported wrong. Phrases carry ±2 weight — a phrase outweighs a
//      solitary opposite-polarity word. Without this pass, "profit
//      fall" became [profit, fall] → pos=1 neg=1 → neutral. Wrong.
//   2. Word pass — single-token scan, each hit carries ±1.
//
// Final tier rule — uses ABSOLUTE net signal, not normalized ratio.
// Previously `total = pos+neg` was the denominator, so a headline
// with one positive word and zero negative got ratio=1.0 → strongly_
// positive. That's why the DB over-produced strongly_positive.
// Now: strongly_* requires net >= 3 net signal strength; milder
// labels otherwise.
//
// Score range kept at [-1, 1] for downstream consumers, but it's now
// `clamp(net / 5, -1, 1)` — meaning you need ~5 net hits to saturate.

const POSITIVE_PHRASES: string[] = [
  // actions / recommendations
  'buy recommendation', 'buy rating', 'upgrade to buy', 'target raised',
  'price target raised', 'strong buy', 'overweight rating',
  // performance
  'record profit', 'record high', 'all-time high', 'beat estimates',
  'beat expectations', 'beat forecast', 'exceeds expectations',
  'better than expected', 'strong growth', 'robust growth', 'profit jump',
  'profit surge', 'profit rises', 'revenue jump', 'revenue surge',
  'sales growth', 'margin expansion', 'earnings beat',
  // market moves
  'hits record', 'hits high', 'breakout above', 'breaks out',
  'sharp rally', 'strong rally', 'bull run',
  // corporate
  'dividend hike', 'bonus issue', 'stock split announced', 'share buyback',
  'order win', 'new contract', 'acquisition completed',
];

const NEGATIVE_PHRASES: string[] = [
  // performance drops
  'profit fall', 'profit falls', 'profit drop', 'profit plunge',
  'profit slump', 'profit miss', 'profit warning', 'earnings miss',
  'revenue fall', 'revenue miss', 'revenue decline', 'sales drop',
  'sales fall', 'margin pressure', 'margin compression', 'margin squeeze',
  'miss estimates', 'miss expectations', 'miss forecast',
  'worse than expected', 'below estimates', 'below expectations',
  // actions / recommendations
  'sell recommendation', 'sell rating', 'downgrade to sell',
  'target cut', 'target lowered', 'underweight rating', 'price target cut',
  // market moves
  'sell-off', 'sell off', 'heavy selling', 'sharp fall', 'sharp decline',
  'sharp drop', 'stock plunge', 'stock crash', 'shares tumble',
  'shares fall', 'shares drop', 'shares plunge', 'hits low', 'hits 52-week low',
  'bear market', 'bear run',
  // corporate / governance
  'dividend cut', 'debt concerns', 'debt burden', 'regulatory action',
  'sebi probe', 'sebi action', 'tax notice', 'fraud charge',
  'class action', 'insolvency', 'bankruptcy filing', 'going concern',
];

// Word sets include morphological variants for every verb that
// changes form across tense / plural. A headline saying "Reliance
// rises 3%" needs `rises` to hit; "shares fell" needs `fell`. The
// tokenizer splits on \W+ but doesn't stem, so each surface form
// must be listed explicitly.
const POSITIVE_WORDS = new Set([
  // base
  'surge', 'rally', 'jump', 'gain', 'rise', 'bull', 'bullish', 'upbeat',
  'outperform', 'upgrade', 'beat', 'record', 'boom', 'optimistic',
  'growth', 'dividend', 'buyback', 'strong', 'recovery', 'breakout',
  'expansion', 'approve', 'exceed', 'robust', 'momentum',
  // plural / 3rd-person
  'surges', 'rallies', 'jumps', 'gains', 'rises', 'outperforms',
  'upgrades', 'beats', 'records', 'approves', 'exceeds', 'buybacks',
  'recoveries', 'breakouts', 'expansions',
  // -ing
  'surging', 'rallying', 'jumping', 'gaining', 'rising', 'outperforming',
  'upgrading', 'beating', 'growing', 'recovering', 'expanding',
  'approving', 'exceeding',
  // past tense
  'surged', 'rallied', 'jumped', 'gained', 'rose', 'risen',
  'outperformed', 'upgraded', 'beaten', 'grew', 'grown',
  'recovered', 'expanded', 'approved', 'exceeded',
]);
// `profit`, `positive`, `high` removed from single-word positives —
// too ambiguous without context. "profit fall" / "52-week high" /
// "positive news → no…" are common traps.

const NEGATIVE_WORDS = new Set([
  // base
  'crash', 'plunge', 'drop', 'fall', 'decline', 'bear', 'bearish', 'slump',
  'loss', 'downgrade', 'miss', 'bust', 'pessimistic', 'weak',
  'default', 'penalty', 'fraud', 'scam', 'ban', 'warning',
  'correction', 'selloff', 'negative', 'contraction', 'reject',
  'concern', 'recession', 'crisis', 'fail',
  // plural / 3rd-person
  'crashes', 'plunges', 'drops', 'falls', 'declines', 'slumps',
  'losses', 'downgrades', 'misses', 'defaults', 'penalties', 'frauds',
  'bans', 'warnings', 'corrections', 'concerns', 'crises', 'fails',
  'rejects', 'weakens',
  // -ing
  'crashing', 'plunging', 'dropping', 'falling', 'declining', 'slumping',
  'losing', 'downgrading', 'missing', 'defaulting', 'rejecting',
  'failing', 'weakening', 'banning', 'warning',
  // past tense
  'crashed', 'plunged', 'dropped', 'fell', 'fallen', 'declined',
  'slumped', 'lost', 'downgraded', 'missed', 'defaulted', 'rejected',
  'failed', 'weakened', 'banned',
]);

// Token-level negators — when any appears within NEGATION_WINDOW tokens
// before a sentiment hit, that hit's polarity flips.
const NEGATORS = new Set([
  'not', 'no', 'never', 'without', 'despite',
  'lacks', 'lack', 'failed', 'fails', 'failing',
  "didn't", "doesn't", "don't", "won't", "wasn't", "weren't", "isn't", "aren't",
  'didnt', 'doesnt', 'dont', 'wont', 'wasnt', 'werent', 'isnt', 'arent',
]);
const NEGATION_WINDOW = 5;

// Phrase-level negators — multi-token expressions that negate whatever
// sentiment phrase immediately follows. Token-level negation misses
// these because the negation "particle" is itself a multi-word span.
const PHRASE_NEGATORS: string[] = [
  'no sign of', 'no signs of', 'lack of', 'absence of', 'shortage of',
  'failure to', 'failed to', 'unable to', 'no evidence of',
  'yet to', 'still waiting for', 'far from',
];

// Contrast markers — split headlines into clauses. Everything AFTER the
// marker carries more weight than everything before, because financial
// writing puts the operative statement in the second clause:
//   "Despite fall in Q4, stock hits new high"  — rally wins
//   "Weak earnings but strong guidance"        — guidance wins
const CONTRAST_MARKERS: RegExp = /\b(despite|however|but|although|even though|while|yet|though)\b/i;

// Weight multiplier for the clause following a contrast marker.
// 3× is empirically required: a first-clause phrase hit already carries
// 2× weight (phrase pass) so a 2× last-clause weight only ties, never
// dominates. 3× ensures the last clause wins even against a phrase in
// the first ("Profit rises but outlook weak" → negative).
const POST_CONTRAST_WEIGHT = 3;

// Market-noise headlines — mandate category='general' regardless of
// body content. Articles whose title matches one of these patterns
// are market commentary or index-level wraps, never single-stock
// catalysts, and must not reach the strong tier even if the body
// sweeps many positive keywords.
//
// The pattern list covers three shapes:
//   1. India market wraps:      "Ahead of Market", "Nifty opens", "Sensex today"
//   2. Global / cross-market:   "US stocks", "Asian markets", "World markets"
//   3. Macro / commodity leads: "Crude oil", "Dollar index", "Fed signals"
const MARKET_NOISE_TITLE = new RegExp(
  '^\\s*(' +
    // India market wraps
    'ahead of market|market today|market wrap|market update|market at close|' +
    'market live|stock market today|sensex today|nifty today|' +
    'sensex opens|nifty opens|sensex closes|nifty closes|' +
    'morning brief|daily market|opening bell|closing bell|' +
    // Global / cross-market
    'global cues|us stocks|us markets|asian stocks|asian markets|' +
    'european stocks|european markets|europe markets|world markets|' +
    'global markets|global stocks|wall street|' +
    // Macro / commodity / FX leads
    'crude oil|dollar index|bond yields|fed signals|fed holds|fed cuts|fed raises|' +
    'rbi signals|rbi holds|rbi cuts|rbi raises|inflation|' +
    'gdp (growth|data)|jobs report' +
  ')\\b',
  'i',
);

// Per-clause scan that reports word-hit polarity with token-level
// negation awareness. Returns weighted counts — the `weight` arg lets
// the caller double-count post-contrast clauses.
function scanClause(
  clauseText: string,
  weight: number,
): { pos: number; neg: number } {
  const words = clauseText.split(/\W+/).filter(Boolean);
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isPos = POSITIVE_WORDS.has(w);
    const isNeg = NEGATIVE_WORDS.has(w);
    if (!isPos && !isNeg) continue;
    let negated = false;
    for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) {
      if (NEGATORS.has(words[j])) { negated = true; break; }
    }
    if (isPos) {
      if (negated) neg += weight; else pos += weight;
    } else {
      if (negated) pos += weight; else neg += weight;
    }
  }
  return { pos, neg };
}

// Phrase pass — respects phrase-level negators. Returns count of
// non-negated phrase hits per polarity. A phrase hit preceded by a
// PHRASE_NEGATOR (within 8 chars) flips that hit's polarity instead.
function countPhrasesWithNegation(
  lowerText: string,
  phrases: string[],
  negaters: string[],
): { unflipped: number; flipped: number } {
  let unflipped = 0;
  let flipped = 0;
  for (const p of phrases) {
    let from = 0;
    while (true) {
      const idx = lowerText.indexOf(p, from);
      if (idx === -1) break;
      // Check if a phrase-level negator ends within 1–25 chars before
      // the phrase. 25 chars is roughly 5 words — the equivalent of
      // the token-level negation window.
      const preStart = Math.max(0, idx - 25);
      const pre = lowerText.slice(preStart, idx);
      const wasNegated = negaters.some((n) => pre.includes(n));
      if (wasNegated) flipped++;
      else unflipped++;
      from = idx + p.length;
    }
  }
  return { unflipped, flipped };
}

// Category tags for which we cap the max label at plain positive /
// negative. Market-recap / preview / macro articles routinely contain
// several positive keywords (rally, gains, momentum) without being a
// catalyst for any one stock, so they shouldn't saturate the strong
// tier.
const NO_STRONG_TIER_CATEGORIES = new Set<string>([
  'general', 'market_overview', 'global_cue',
  'macro',          // explicit macro-economic headlines
  'commodity',      // crude / gold / metals commentary
  'forex',          // currency / dollar / yen commentary
  'market_recap',   // daily summary articles
]);

// Intent extraction — the imperative dominance rule. A Buy/Accumulate/
// Add title is a long recommendation; Sell/Reduce/Exit/Trim is a
// short/exit recommendation. When intent is detected, the final label
// is FLOOR-LOCKED to that polarity.
//
// Detection fires in four patterns (real Indian press headlines):
//   1. Leading imperative:        "Buy Adani Green for 25% upside"
//   2. Broker-colon prefix:        "Motilal Oswal: Buy Adani Green"
//   3. Semicolon/dash pivot:       "Target raised — Buy Adani Green"
//   4. Buy/Sell noun-phrase:       "Buy call on Adani Green"
//                                  "Strong buy rating on Adani Green"
//
// Body text is NOT scanned for intent — body verbs produce false
// positives ("… and investors should not buy the dip").
function detectIntent(title: string): 'buy' | 'sell' | null {
  const t = String(title).trim();

  // Pattern 1: leading imperative.
  if (/^\s*(buy|accumulate|add|long)\b/i.test(t))                 return 'buy';
  if (/^\s*(sell|reduce|exit|book\s*profit|trim|short)\b/i.test(t)) return 'sell';

  // Pattern 2 & 3: imperative after broker prefix or pivot punctuation.
  // Matches "Motilal: Buy X", "HDFC Sec — Buy X", "Target raised; Buy X".
  if (/[:;—\-]\s*(buy|accumulate|add)\b/i.test(t))            return 'buy';
  if (/[:;—\-]\s*(sell|reduce|exit|trim)\b/i.test(t))         return 'sell';

  // Pattern 4: recommendation noun-phrases anywhere in title. These
  // carry the same directional commitment as an imperative verb.
  if (/\b(strong\s+buy|buy\s+call|buy\s+rating|buy\s+recommendation|upgrade\s+to\s+buy|maintain\s+buy|reiterate\s+buy|add\s+on\s+dips)\b/i.test(t)) {
    return 'buy';
  }
  if (/\b(strong\s+sell|sell\s+call|sell\s+rating|sell\s+recommendation|downgrade\s+to\s+sell|maintain\s+sell|reiterate\s+sell|reduce\s+position)\b/i.test(t)) {
    return 'sell';
  }

  return null;
}

// Split a piece of text into clauses at contrast markers. Returns an
// array of { text, weight } with the LAST clause given the highest
// weight. A sentence with no contrast marker returns as a single
// clause with weight 1.
function splitIntoWeightedClauses(
  text: string,
): Array<{ text: string; weight: number }> {
  // Split on contrast markers, keeping the remainder as final clause.
  const parts = text.split(CONTRAST_MARKERS).filter((p) => p && !CONTRAST_MARKERS.test(p));
  if (parts.length <= 1) return [{ text, weight: 1 }];
  return parts.map((p, i) => ({
    text: p,
    weight: i === parts.length - 1 ? POST_CONTRAST_WEIGHT : 1,
  }));
}

/**
 * Multi-layer sentiment classifier.
 *
 * Pipeline per call:
 *   1. Intent extraction      — imperative verb at title start locks polarity floor.
 *   2. Clause segmentation    — split on contrast markers, final clause weighted 2×.
 *   3. Phrase pass            — multi-word hits, phrase-level negation aware.
 *   4. Word pass (per clause) — single-word hits, token-level negation aware.
 *   5. Signal aggregation     — sum phrase + word + imperative contributions.
 *   6. Tier assignment        — uses absolute net signal + decisiveness + category gate.
 *   7. Contradiction guard    — force label back into imperative-compatible range.
 *
 * Returns {label, score}. Score in [-1, +1], saturates around ±5 net hits.
 */
function scoreSentiment(
  title: string,
  body:  string | null,
  category: string = 'general',
): { label: SentimentLabel; score: number } {
  const fullText = `${title} ${body ?? ''}`;
  const lowered  = fullText.toLowerCase();

  // ── Stage 0: market-noise headline override ────────────────
  // Force category='general' when the title is a market-commentary
  // wrapper ("Ahead of Market", "Opening Bell"). These articles are
  // never catalysts for a single stock even when their body sweeps
  // several positive keywords across sector rotations.
  const effectiveCategory = MARKET_NOISE_TITLE.test(String(title))
    ? 'general'
    : category;

  // ── Stage 1: intent extraction ─────────────────────────────
  const intent = detectIntent(title);

  // ── Stage 2+3+4: clause segmentation + per-clause phrase AND
  // word scan. Both passes run per-clause so a first-clause phrase
  // hit respects the clause-weight multiplier the same way word
  // hits do. Previously phrase scanning was on full text, which
  // meant "Profit rises but outlook weak" saw the positive phrase
  // at full weight regardless of which clause it sat in — tying
  // with the negatively-weighted last clause. Now the phrase
  // contributes with its own clause's weight.
  const clauses = splitIntoWeightedClauses(lowered);
  let posPhrases = 0;
  let negPhrases = 0;
  let posWords   = 0;
  let negWords   = 0;
  for (const c of clauses) {
    // Phrase pass per clause — phrase-level negation aware.
    const pos = countPhrasesWithNegation(c.text, POSITIVE_PHRASES, PHRASE_NEGATORS);
    const neg = countPhrasesWithNegation(c.text, NEGATIVE_PHRASES, PHRASE_NEGATORS);
    posPhrases += (pos.unflipped + neg.flipped) * c.weight;
    negPhrases += (neg.unflipped + pos.flipped) * c.weight;
    // Word pass per clause — token-level negation aware.
    const w = scanClause(c.text, c.weight);
    posWords += w.pos;
    negWords += w.neg;
  }

  // ── Stage 5: signal aggregation ────────────────────────────
  // Imperative contributes a strong 3× weight so it dominates body
  // noise unless the body is unambiguously catastrophic (4+ net
  // negative signals would still drag a Buy headline to neutral, but
  // the contradiction guard below will catch that case).
  const IMPERATIVE_WEIGHT = 3;
  const posImperative = intent === 'buy'  ? IMPERATIVE_WEIGHT : 0;
  const negImperative = intent === 'sell' ? IMPERATIVE_WEIGHT : 0;

  const posSignal = posPhrases * 2 + posImperative + posWords;
  const negSignal = negPhrases * 2 + negImperative + negWords;
  const net       = posSignal - negSignal;
  const total     = posSignal + negSignal;

  if (total === 0 && !intent) {
    return { label: 'neutral', score: 0 };
  }

  // ── Stage 6: tier assignment ───────────────────────────────
  // Decisiveness = share of signal agreeing with the dominant side.
  // Strong tier requires:
  //   1. net ≥ 4 (non-trivial magnitude)
  //   2. decisiveness ≥ 0.75 (opposite polarity is minor)
  //   3. category is not a generic overview
  // Otherwise milder labels.
  let label: SentimentLabel;
  const dominant     = Math.max(posSignal, negSignal);
  const opposite     = Math.min(posSignal, negSignal);
  const decisiveness = total > 0 ? dominant / total : 0;
  const allowStrong  = dominant >= 4
                    && decisiveness >= 0.75
                    && !NO_STRONG_TIER_CATEGORIES.has(effectiveCategory);

  if      (net >=  4 && allowStrong) label = 'strongly_positive';
  else if (net >=  1)                label = 'positive';
  else if (net <= -4 && allowStrong) label = 'strongly_negative';
  else if (net <= -1)                label = 'negative';
  else                               label = 'neutral';

  // ── Stage 7: contradiction guard ───────────────────────────
  // Imperative dominance — a Buy headline cannot resolve to negative
  // or neutral; a Sell headline cannot resolve to positive or neutral.
  // When the body has contradicted the imperative hard enough to
  // produce a contradictory label, snap back to the intent's polarity.
  // This is the "act like a trader" rule — operators reading "Buy X"
  // should see positive, not negative, regardless of cautious body.
  if (intent === 'buy' && (label === 'negative' || label === 'strongly_negative' || label === 'neutral')) {
    label = 'positive';
  } else if (intent === 'sell' && (label === 'positive' || label === 'strongly_positive' || label === 'neutral')) {
    label = 'negative';
  }

  // Score in [-1, 1], saturating at ~5 net hits. When the imperative
  // overrode the label, also reflect that in the numeric score so
  // downstream consumers see consistent sign.
  let score = Math.max(-1, Math.min(1, net / 5));
  if (intent === 'buy'  && score < 0.2) score = 0.2;
  if (intent === 'sell' && score > -0.2) score = -0.2;
  return { label, score: Math.round(score * 1000) / 1000 };
}

// ── Main Normalizer ──────────────────────────────────────────────

export function normalizeRawItem(raw: RawNewsItem): NewsEvent | null {
  // Validation gate. An article without a parseable title is noise;
  // without a valid publishedAt the downstream freshness / decay
  // engines can't place it in time. Dropping here keeps the DB clean
  // and the aggregator honest (no rows with NULL sentiment or 1970
  // dates leaking into counts).
  const title = String(raw.title ?? '').trim();
  if (!title) return null;
  const publishedMs = raw.publishedAt ? new Date(raw.publishedAt).getTime() : NaN;
  if (!Number.isFinite(publishedMs)) return null;

  const dedupHash = computeDedupHash(raw);
  const category = classifyCategory(raw.title, raw.body);
  const { label: sentiment, score: sentimentScore } = scoreSentiment(raw.title, raw.body, category);
  const entities = resolveEntities(raw.title, raw.body, raw.rawMeta);

  // Global / macro stories (US market moves, Fed policy, geopolitics)
  // should NOT be tagged with individual NSE tickers. The resolver
  // will still surface sectors / macroFactors / commodities — those
  // are genuinely useful on a macro article — but per-symbol impact
  // attachment is wrong for "US stocks opened lower…"-style rows.
  const suppressSymbols = category === 'global_cue' || category === 'macro_policy';

  const symbols: string[] = [];
  const sectors: string[] = [];
  const macroFactors: string[] = [];
  const commodities: string[] = [];

  for (const e of entities) {
    switch (e.entityType) {
      case 'symbol':       if (!suppressSymbols) symbols.push(e.entityValue); break;
      case 'sector':       sectors.push(e.entityValue); break;
      case 'macro_factor': macroFactors.push(e.entityValue); break;
      case 'commodity':    commodities.push(e.entityValue); break;
    }
  }

  return {
    sourceId:       raw.sourceId,
    externalId:     raw.externalId,
    dedupHash,
    title:          raw.title,
    body:           raw.body,
    url:            raw.url,
    category,
    sentiment,
    sentimentScore,
    publishedAt:    raw.publishedAt,
    fetchedAt:      raw.fetchedAt,
    entities,
    symbols:        [...new Set(symbols)],
    sectors:        [...new Set(sectors)],
    macroFactors:   [...new Set(macroFactors)],
    commodities:    [...new Set(commodities)],
    isProcessed:    true,
  };
}

/**
 * Batch normalize an array of raw items. Filters out rows rejected
 * by the validation gate inside normalizeRawItem (no title, bad
 * publishedAt). The filter is type-safe: `NewsEvent | null` → `NewsEvent`.
 */
export function normalizeAll(items: RawNewsItem[]): NewsEvent[] {
  return items
    .map(normalizeRawItem)
    .filter((e): e is NewsEvent => e !== null);
}
