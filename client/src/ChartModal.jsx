import { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const RANGES = [
  { id: '1m', label: '1m' },
  { id: '1H', label: '1H' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
];

function suggestSymbol(currency) {
  const c = String(currency || '').trim().toUpperCase();
  if (!c || c === 'ALL') return 'BTCUSDT';
  return c.length === 3 ? c : 'BTCUSDT';
}

export default function ChartModal({ row, onClose }) {
  const [input, setInput] = useState(() => (row?.currency ? suggestSymbol(row.currency) : ''));
  const [symbol, setSymbol] = useState(() => (row?.currency ? suggestSymbol(row.currency) : ''));
  const [range, setRange] = useState('7d');
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCandles([]);
    fetch(`${API_BASE}/api/prices?symbol=${encodeURIComponent(symbol)}&range=${range}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
        setCandles(body.candles || []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, range]);

  useEffect(() => {
    if (!containerRef.current || loading || error || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8a93a6',
        fontFamily: "'Departure Mono', 'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1c212b' },
        horzLines: { color: '#1c212b' },
      },
      rightPriceScale: { borderColor: '#262c38' },
      timeScale: { borderColor: '#262c38', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: '#545d6f', labelBackgroundColor: '#262c38' },
        horzLine: { color: '#545d6f', labelBackgroundColor: '#262c38' },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#5fbf77',
      downColor: '#d9695f',
      borderUpColor: '#5fbf77',
      borderDownColor: '#d9695f',
      wickUpColor: '#5fbf77',
      wickDownColor: '#d9695f',
    });
    series.setData(candles);

    return () => chart.remove();
  }, [candles, loading, error]);

  function submitSymbol(e) {
    e.preventDefault();
    const clean = input.trim().toUpperCase();
    if (clean && clean !== symbol) setSymbol(clean);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal--chart"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Price chart"
      >
        <div className="modal__head">
          <h3>
            {row?.currency ? `${row.currency} — ${row.title}` : 'Price chart'}
          </h3>
          <button className="modal__close" onClick={onClose} type="button" aria-label="Close">
            ×
          </button>
        </div>

        <div className="chart__toolbar">
          <form className="chart__symbol-form" onSubmit={submitSymbol}>
            <input
              className="chart__symbol-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="CAD, BTCUSDT, EURUSD…"
              autoComplete="off"
              spellCheck="false"
            />
            <button className="modal__save" type="submit" disabled={loading}>
              Go
            </button>
          </form>
          <div className="chart__ranges">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                data-active={range === r.id}
                className="chart__range-btn"
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {loading && <div className="chart__status">Loading {symbol}…</div>}

        {!loading && error && <div className="chart__status chart__status--error">{error}</div>}

        {!loading && !error && candles.length === 0 && (
          <div className="chart__status">No price data for {symbol}.</div>
        )}

        {!loading && !error && candles.length > 0 && (
          <div className="chart__wrap">
            <div className="chart__canvas" ref={containerRef} />
            <div className="chart__meta">
              Source: Binance (public market data) · {symbol} · last {range}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}