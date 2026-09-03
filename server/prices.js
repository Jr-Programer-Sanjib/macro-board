// Live market data for the chart popup. Two free upstreams, no key needed:
//  - Binance public market data (data-api.binance.vision) for crypto pairs.
//  - Yahoo Finance chart API for forex currencies (which Binance delisted).
//
// The /api/prices route accepts a "symbol". If the symbol is a bare currency
// code (e.g. "CAD", "EUR", "BTC") or a forex pair (e.g. "EURUSD", "USDJPY=X"),
// it's auto-routed to the right provider; "BTCUSDT"-style inputs go to Binance.
const BINANCE_KLINE_URL = 'https://data-api.binance.vision/api/v3/klines';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const FRANKFURTER_URL = 'https://api.frankfurter.app';

// How many symbol->ISO dates to pull for the Frankfurter (daily) fallback.
const FRANKFURTER_MAX_DAYS = 120;
const FRANKFURTER_MIN_DAYS = 30;

const BINANCE_RANGES = {
  '1m': { interval: '1m', limit: 60 },
  '1H': { interval: '1h', limit: 168 },
  '24h': { interval: '15m', limit: 96 },
  '7d': { interval: '1h', limit: 168 },
  '30d': { interval: '4h', limit: 180 },
};

const YAHOO_RANGES = {
  '1m': { interval: '1m', range: '1d' },
  '1H': { interval: '60m', range: '5d' },
  '24h': { interval: '15m', range: '1d' },
  '7d': { interval: '1h', range: '5d' },
  '30d': { interval: '1d', range: '1mo' },
};

// Currency code -> Yahoo FX ticker (quoted against USD).
const FX_YAHOO = {
  AUD: 'AUDUSD=X',
  CAD: 'USDCAD=X',
  CHF: 'USDCHF=X',
  CNY: 'USDCNY=X',
  EUR: 'EURUSD=X',
  GBP: 'GBPUSD=X',
  JPY: 'USDJPY=X',
  NZD: 'NZDUSD=X',
  TRY: 'USDTRY=X',
  ZAR: 'USDZAR=X',
};

// Currencies that appear in the calendar but are crypto, charted via Binance.
const CRYPTO = new Set([
  'BTC', 'ETH', 'BNB', 'XRP', 'ADA', 'SOL', 'DOGE', 'LTC', 'BCH',
  'MATIC', 'DOT', 'LINK', 'SHIB', 'AVAX', 'TRX', 'UNI', 'XLM', 'NEAR',
]);

// Commodities / metals that can be charted. Yahoo futures are the live source;
// when Yahoo is unavailable on a datacenter (Render), we fall back to a
// Binance tokenized proxy for those that have one.
const COMMODITY_YAHOO = {
  XAU: 'GC=F',   // gold futures
  GOLD: 'GC=F',
  XAG: 'SI=F',   // silver futures
  SILVER: 'SI=F',
  XPT: 'PL=F',   // platinum futures
  OIL: 'CL=F',   // WTI crude futures
  WTI: 'CL=F',
  BRENT: 'BZ=F', // Brent crude futures
  NATGAS: 'NG=F',// natural gas futures
  COPPER: 'HG=F',// copper futures
};
// Binance tokenized fallback for common metals (works from datacenter IPs).
const COMMODITY_BINANCE = {
  XAU: 'PAXGUSDT', // Pax Gold - tracks gold price
  GOLD: 'PAXGUSDT',
};

const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 60_000);
const priceCache = new Map(); // key: provider|param|range -> { ttl, data }

const FIAT = new Set(['USD', 'EURI', ...Object.keys(FX_YAHOO)]);

function normalizeRange(raw) {
  return BINANCE_RANGES[raw] ? raw : '24h';
}

// Route a user-entered symbol to a provider + upstream key.
function resolve(symbol) {
  const s = String(symbol || '').trim().toUpperCase();

  // Bare currency code -> forex via Yahoo, commodity via Yahoo futures, or crypto via Binance.
  if (/^[A-Z]{3}$/.test(s)) {
    if (FX_YAHOO[s]) return { provider: 'yahoo', param: FX_YAHOO[s], label: s };
    if (CRYPTO.has(s)) return { provider: 'binance', param: `${s}USDT`, label: `${s}USDT` };
    if (COMMODITY_YAHOO[s]) return { provider: 'yahoo', param: COMMODITY_YAHOO[s], label: s, commodity: s };
    throw new Error(`No chart source for the "${s}" currency yet — try a crypto pair like BTCUSDT.`);
  }

  // 4-letter commodity names (GOLD, WTI, etc.) -> Yahoo futures.
  if (/^[A-Z]{4}$/.test(s) && COMMODITY_YAHOO[s]) {
    return { provider: 'yahoo', param: COMMODITY_YAHOO[s], label: s, commodity: s };
  }

  // Commodity in XAUUSD / XAGUSD form -> still the metal, charted via futures.
  const metalFrom6 = s.includes('XAU') || s.includes('GOLD') || s.includes('XAG') || s.includes('SILVER') || s.includes('OIL') || s.includes('CL=') ? s.slice(0, 3) : null;
  if (metalFrom6 && COMMODITY_YAHOO[metalFrom6]) {
    return { provider: 'yahoo', param: COMMODITY_YAHOO[metalFrom6], label: metalFrom6, commodity: metalFrom6 };
  }

  // Forex pair (EURUSD=X, USDJPY=X, or bare EURUSD/USDJPY form) -> Yahoo.
  let fx = s.endsWith('=X') ? s : /^[A-Z]{6}$/.test(s) ? `${s}=X` : null;
  if (fx) {
    const pair = fx.slice(0, 6);
    const a = pair.slice(0, 3);
    const b = pair.slice(3, 6);
    if (FIAT.has(a) && FIAT.has(b)) {
      return { provider: 'yahoo', param: fx, label: pair };
    }
  }

  // Anything else is treated as a Binance pair (BTCUSDT, ETHUSDT, ...).
  return { provider: 'binance', param: s, label: s };
}

async function fetchBinance(param, range) {
  const { interval, limit } = BINANCE_RANGES[range];
  const url = `${BINANCE_KLINE_URL}?symbol=${encodeURIComponent(param)}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (res.status === 400 || res.status === 422) {
    throw new Error(`Unknown symbol "${param}" — crypto pairs like BTCUSDT are available.`);
  }
  if (!res.ok) {
    throw new Error(`Price feed responded ${res.status}`);
  }

  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('Price feed returned an unexpected shape');

  // Binance kline row: [openTime(ms), open, high, low, close, volume, ...]
  return raw.map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  }));
}

async function fetchYahoo(param, range) {
  const { interval, range: yRange } = YAHOO_RANGES[range];
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(param)}?interval=${interval}&range=${yRange}&includePrePost=false`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Yahoo responded ${res.status} for ${param.replace('=X', '')}`);
  }
  const body = await res.json();
  if (body.chart?.error) {
    throw new Error(`Unknown symbol "${param.replace('=X', '')}".`);
  }
  const result = body.chart?.result?.[0];
  if (!result?.timestamp || !result?.indicators?.quote?.[0]) {
    throw new Error('Price feed returned an unexpected shape');
  }

  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c });
  }
  if (!candles.length) throw new Error('No price data for this symbol.');

  // 1m over Yahoo's 1d range can return ~1000 points; trim to the most recent
  // 240 so the chart stays readable without losing the recent action.
  if (interval === '1m' && candles.length > 240) {
    return candles.slice(-240);
  }
  return candles;
}

// Free, no-key ECB fallback for forex when Yahoo Finance is rate-limited or
// blocked on a hosting provider's datacenter IPs. Returns daily candles only.
const FRANKFURTER_RANGE_DAYS = {
  '1m': 30,
  '1H': 30,
  '24h': 30,
  '7d': 60,
  '30d': 120,
};

async function fetchFrankfurter(from, to, range) {
  const days = FRANKFURTER_RANGE_DAYS[range] || FRANKFURTER_MIN_DAYS;
  const end = new Date(Date.now());
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const url = `${FRANKFURTER_URL}/${iso(start)}..${iso(end)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Frankfurter responded ${res.status}`);
  }
  const body = await res.json();
  const series = body?.rates;
  if (!series) throw new Error('Frankfurter returned an unexpected shape');

  const rates = Object.keys(series)
    .sort()
    .map((date) => ({ date, v: series[date][to] }))
    .filter((r) => typeof r.v === 'number');

  if (!rates.length) throw new Error('No daily rate data from fallback source.');

  // Build OHLC candles. Without intraday ticks we only have a daily close, so
  // open/high/low fall back to the close for a clean but coarse daily chart.
  let candles = rates.map((r) => {
    const t = new Date(`${r.date}T12:00:00Z`).getTime() / 1000;
    return { time: t, open: r.v, high: r.v, low: r.v, close: r.v };
  });

  // Trim intraday ranges to something readable (we don't have intraday data).
  if (range === '1m' || range === '1H' || range === '24h') {
    candles = candles.slice(-FRANKFURTER_MIN_DAYS);
  }
  if (!candles.length) throw new Error('No price data for this symbol.');
  return candles;
}

export async function getPrices(rawSymbol, rawRange, now = Date.now()) {
  const range = normalizeRange(rawRange);
  if (!rawSymbol) throw new Error('Missing symbol');

  const { provider, param, label, commodity } = resolve(rawSymbol);
  const key = `${provider}|${param}|${range}`;
  const cached = priceCache.get(key);
  if (cached && now < cached.ttl) {
    return { ...cached.data, cached: true };
  }

  let candles;
  let source;
  let providerUsed = provider;

  if (provider === 'yahoo') {
    if (commodity) {
      // Commodities: Yahoo futures first (live). On datacenter hosts where
      // Yahoo is blocked/429, fall back to a Binance tokenized proxy for the
      // metals that have one (gold only), else surface a clean error.
      try {
        candles = await fetchYahoo(param, range);
        source = 'Yahoo Finance (live Futures)';
      } catch (err) {
        const token = COMMODITY_BINANCE[commodity];
        if (token) {
          candles = await fetchBinance(token, range);
          providerUsed = 'binance';
          source = `Binance tokenized (${token}) — Yahoo blocked`;
        } else {
          throw new Error(
            `Yahoo Finance is blocked here (rate-limited) and there's no free fallback for ${commodity}. Gold works; silver/oil need Yahoo.`
          );
        }
      }
    } else {
      // Fiat forex: Yahoo first (live intraday). On hosts where Yahoo is
      // blocked/429, fall back to Frankfurter (free ECB daily data).
      try {
        candles = await fetchYahoo(param, range);
        source = 'Yahoo Finance (live Forex)';
      } catch (err) {
        const pair = label; // e.g. "EURUSD"
        const from = pair.slice(0, 3);
        const to = pair.slice(3, 6);
        candles = await fetchFrankfurter(from, to, range);
        providerUsed = 'frankfurter';
        source = 'Frankfurter (daily Forex fallback)';
      }
    }
  } else {
    candles = await fetchBinance(param, range);
    source = 'Binance (public market data)';
  }

  const data = {
    symbol: label,
    range,
    source,
    candles,
  };
  priceCache.set(key, { ttl: now + PRICE_CACHE_TTL_MS, data });
  return { ...data, cached: false };
}