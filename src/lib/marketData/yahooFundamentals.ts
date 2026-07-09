/**
 * Yahoo Finance quoteSummary fundamentals — free fallback when IndianAPI
 * is rate-limited or returns empty valuation fields.
 *
 * Uses Yahoo's public crumb flow (fc.yahoo.com cookie → getcrumb →
 * quoteSummary). No API key required.
 */

import { toYahooSymbol } from '@/lib/marketData/symbolNormalize';

export interface YahooFundamentals {
  symbol:          string;
  companyName:     string | null;
  sector:          string | null;
  industry:        string | null;
  pe:              number | null;
  forwardPe:       number | null;
  eps:             number | null;
  marketCap:       number | null;
  bookValue:       number | null;
  pbRatio:         number | null;
  beta:            number | null;
  roe:             number | null;
  debtToEquity:    number | null;
  dividendYield:   number | null;
  week52High:      number | null;
  week52Low:       number | null;
}

const UA = 'Mozilla/5.0 (compatible; Quantorus365/2.1)';

interface CrumbSession {
  cookie: string;
  crumb:  string;
  at:     number;
}

let crumbSession: CrumbSession | null = null;
const CRUMB_TTL_MS = 45 * 60 * 1000;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rawField(obj: Record<string, unknown> | undefined, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  if (v && typeof v === 'object' && 'raw' in (v as object)) {
    return num((v as { raw?: unknown }).raw);
  }
  return num(v);
}

async function resolveCrumbSession(): Promise<CrumbSession | null> {
  if (crumbSession && Date.now() - crumbSession.at < CRUMB_TTL_MS) {
    return crumbSession;
  }

  try {
    const boot = await fetch('https://fc.yahoo.com/finance/news/us/en/index.html', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    // Yahoo returns 404 on this bootstrap URL but still issues session cookies.

    const setCookies = boot.headers.getSetCookie?.() ?? [];
    let cookie = setCookies
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
    if (!cookie) {
      const raw = boot.headers.get('set-cookie');
      if (raw) cookie = raw.split(',').map((c) => c.split(';')[0].trim()).join('; ');
    }
    if (!cookie) return null;

    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
      signal: AbortSignal.timeout(10_000),
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb) return null;

    crumbSession = { cookie, crumb, at: Date.now() };
    return crumbSession;
  } catch {
    return null;
  }
}

function yahooTicker(symbol: string): string {
  const sym = symbol.toUpperCase().replace(/^(NSE|BSE):/, '').split(':').pop() ?? symbol;
  return toYahooSymbol(sym);
}

/**
 * Fetch valuation / profitability metrics from Yahoo quoteSummary.
 * Returns null when Yahoo is unreachable or the symbol is unknown.
 */
export async function fetchYahooFundamentals(symbol: string): Promise<YahooFundamentals | null> {
  const sym = symbol.trim().toUpperCase();
  const session = await resolveCrumbSession();
  if (!session) return null;

  const ticker = encodeURIComponent(yahooTicker(sym));
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: session.cookie },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;

    const json = await res.json() as {
      quoteSummary?: { result?: Array<Record<string, Record<string, unknown>>> };
    };
    const row = json.quoteSummary?.result?.[0];
    if (!row) return null;

    const sd = row.summaryDetail;
    const ks = row.defaultKeyStatistics;
    const fd = row.financialData;
    const ap = row.assetProfile;

    const roeRaw = rawField(fd, 'returnOnEquity');
    const divRaw = rawField(sd, 'dividendYield');

    return {
      symbol:        sym,
      companyName:   typeof ap?.longName === 'string' ? ap.longName
                    : typeof ap?.shortName === 'string' ? ap.shortName
                    : null,
      sector:        typeof ap?.sector === 'string' ? ap.sector : null,
      industry:      typeof ap?.industry === 'string' ? ap.industry : null,
      pe:            rawField(sd, 'trailingPE'),
      forwardPe:     rawField(sd, 'forwardPE'),
      eps:           rawField(ks, 'trailingEps'),
      marketCap:     rawField(sd, 'marketCap'),
      bookValue:     rawField(ks, 'bookValue'),
      pbRatio:       rawField(ks, 'priceToBook'),
      beta:          rawField(ks, 'beta'),
      roe:           roeRaw != null ? roeRaw * 100 : null,
      debtToEquity:  rawField(fd, 'debtToEquity'),
      dividendYield: divRaw != null ? divRaw * 100 : null,
      week52High:    rawField(sd, 'fiftyTwoWeekHigh'),
      week52Low:     rawField(sd, 'fiftyTwoWeekLow'),
    };
  } catch {
    return null;
  }
}
