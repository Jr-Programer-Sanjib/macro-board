// Live market data for the chart popup. Two free upstreams, no key needed:
//  - Binance public market data (data-api.binance.vision) for crypto pairs.
//  - Yahoo Finance chart API for forex currencies (which Binance delisted).
//
// The /api/prices route accepts a "symbol". If the symbol is a bare currency
// code (e.g. "CAD", "EUR", "BTC") or a forex pair (e.g. "EURUSD", "USDJPY=X"),
// it's auto-routed to the right provider; "BTCUSDT"-style inputs go to Binance.
const BINANCE_KLINE_URL = 'https://data-api.binance.vision/api/v3/klines';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

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

const PRICE_CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS || 60_000);
const priceCache = new Map(); // key: provider|param|range -> { ttl, data }

const FIAT = new Set(['USD', 'EURI', ...Object.keys(FX_YAHOO)]);

function normalizeRange(raw) {
  return BINANCE_RANGES[raw] ? raw : '24h';
}

// Route a user-entered symbol to a provider + upstream key.
function resolve(symbol) {
  const s = String(symbol || '').trim().toUpperCase();

  // Bare currency code -> forex via Yahoo or crypto via Binance.
  if (/^[A-Z]{3}$/.test(s)) {
    if (FX_YAHOO[s]) return { provider: 'yahoo', param: FX_YAHOO[s], label: s };
    if (CRYPTO.has(s)) return { provider: 'binance', param: `${s}USDT`, label: `${s}USDT` };
    throw new Error(`No chart source for the "${s}" currency yet — try a crypto pair like BTCUSDT.`);
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

export async function getPrices(rawSymbol, rawRange, now = Date.now()) {
  const range = normalizeRange(rawRange);
  if (!rawSymbol) throw new Error('Missing symbol');

  const { provider, param, label } = resolve(rawSymbol);
  const key = `${provider}|${param}|${range}`;
  const cached = priceCache.get(key);
  if (cached && now < cached.ttl) {
    return { ...cached.data, cached: true };
  }

  const candles =
    provider === 'yahoo'
      ? await fetchYahoo(param, range)
      : await fetchBinance(param, range);

  const data = {
    symbol: label,
    range,
    source: provider === 'yahoo' ? 'Yahoo Finance (live Forex)' : 'Binance (public market data)',
    candles,
  };
  priceCache.set(key, { ttl: now + PRICE_CACHE_TTL_MS, data });
  return { ...data, cached: false };
}