import { useEffect, useMemo, useState, useCallback } from 'react';
import ChartModal from './ChartModal.jsx';
import AuthModal from './AuthModal.jsx';
import { supabase, isAuthConfigured } from './supabase.js';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const IMPACT_LEVELS = ['high', 'medium', 'low', 'holiday'];
const POLL_MS = 60_000; // server-side cache makes this cheap
const ALERTS_POLL_MS = Number(import.meta.env.VITE_ALERTS_POLL_MS || 30_000);
const LEAD_OPTIONS = [5, 15, 30];

// Only these currencies are shown & chartable: FX majors that the backend can
// chart plus crypto coins. Everything else (INR, RUB, TRY, ...) is hidden from
// the calendar.
const SUPPORTED_CURRENCIES = new Set([
  'AUD', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'JPY', 'NZD', 'TRY', 'ZAR',
  'BTC', 'ETH', 'BNB', 'XRP', 'ADA', 'SOL', 'DOGE', 'LTC', 'BCH',
  'MATIC', 'DOT', 'LINK', 'SHIB', 'AVAX', 'TRX', 'UNI', 'XLM', 'NEAR',
]);

// Settings hub sections. Adding a future feature = add one entry here.
const SETTINGS_SECTIONS = [
  { id: 'bot', icon: '🤖', label: 'Telegram Bot', desc: 'Connect your own bot to receive alerts' },
  { id: 'prefs', icon: '🔔', label: 'Alert preferences', desc: 'On/off, default lead time, per-currency overrides' },
];

function parseNum(v) {
  if (v === null || v === undefined) return null;
  const cleaned = String(v).replace(/[^0-9.+-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null;
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function formatRelative(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m ago`;
}

function dayLabel(iso) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
  })
    .format(new Date(iso))
    .toUpperCase();
}

function timeLabel(iso) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

async function fetchCalendar(range) {
  const res = await fetch(`${API_BASE}/api/calendar?range=${range}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function supabaseToken() {
  if (!isAuthConfigured) return '';
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || '';
}

// Shared authed helper: attaches the Supabase access token to the request. If
// the server says 401 (token stale/expired), force a refresh once and retry.
async function authedJson(method, path, body) {
  const attempt = async (token) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let token = await supabaseToken();
  let res = await attempt(token);

  if (res.status === 401 && token && isAuthConfigured) {
    const { data } = await supabase.auth.refreshSession();
    token = data?.session?.access_token || '';
    res = await attempt(token);
  }
  return res;
}

async function fetchAlertsPrefs() {
  const res = await authedJson('GET', '/api/alerts/prefs');
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const e = new Error('Sign in required');
    e.status = 401;
    throw e;
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function saveAlertsPrefs(patch) {
  const res = await authedJson('POST', '/api/alerts/prefs', patch);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const e = new Error('Sign in required');
    e.status = 401;
    throw e;
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function saveAlertsBot(botToken, chatId) {
  const res = await authedJson('POST', '/api/alerts/bot', { botToken, chatId });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const e = new Error('Sign in required');
    e.status = 401;
    throw e;
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export default function App() {
  const [range, setRange] = useState('week');
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(new Date());
  const [excludedCurrencies, setExcludedCurrencies] = useState(() => new Set());
  const [selectedImpacts, setSelectedImpacts] = useState(() => new Set(IMPACT_LEVELS));
  const [alertState, setAlertState] = useState({
    preferences: null,
    server: null,
    status: 'loading', // 'loading' | 'ready' | 'error'
    error: null,
    saving: false,
  });
  const [botModal, setBotModal] = useState({
    botToken: '',
    chatId: '',
    busy: false,
    error: null,
    result: null,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState('menu'); // 'menu' | section id
  const [chartRow, setChartRow] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [pendingSettings, setPendingSettings] = useState(false);

  const load = useCallback(async (r) => {
    setLoading(true);
    try {
      const body = await fetchCalendar(r);
      setEvents(body.events || []);
      setMeta(body.meta || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
    const poll = setInterval(() => load(range), POLL_MS);
    return () => clearInterval(poll);
  }, [range, load]);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!isAuthConfigured) {
      setAuthChecked(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setAuthChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s || null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function logout() {
    await supabase.auth.signOut();
  }

  const allCurrencies = useMemo(() => {
    const set = new Set(events.map((e) => e.currency));
    return [...set].filter((c) => SUPPORTED_CURRENCIES.has(c)).sort();
  }, [events]);

  const filteredEvents = useMemo(() => {
    return events
      .filter((e) => SUPPORTED_CURRENCIES.has(e.currency))
      .filter((e) => IMPACT_LEVELS.includes(e.impact))
      .filter((e) => selectedImpacts.has(e.impact))
      .filter((e) => !excludedCurrencies.has(e.currency));
  }, [events, selectedImpacts, excludedCurrencies]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const e of filteredEvents) {
      const label = dayLabel(e.time);
      if (!map.has(label)) map.set(label, []);
      map.get(label).push(e);
    }
    return [...map.entries()];
  }, [filteredEvents]);

  const nextHighImpact = useMemo(() => {
    const upcoming = events
      .filter((e) => SUPPORTED_CURRENCIES.has(e.currency))
      .filter((e) => e.impact === 'high' && new Date(e.time).getTime() > now.getTime())
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    return upcoming[0] || null;
  }, [events, now]);

  function toggleCurrency(code) {
    setExcludedCurrencies((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleImpact(level) {
    setSelectedImpacts((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  // --- Alerts ----------------------------------------------------------------
  const loadAlerts = useCallback(async () => {
    try {
      const body = await fetchAlertsPrefs();
      setAlertState({ preferences: body.preferences, server: body.server, status: 'ready', error: null, saving: false });
    } catch (err) {
      if (err.status === 401) {
        setAlertState((s) => ({ ...s, status: 'idle', error: null, saving: false }));
      } else {
        setAlertState((s) => ({ ...s, status: 'error', error: err.message }));
      }
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setAlertState({ preferences: null, server: null, status: 'idle', error: null, saving: false });
      return;
    }
    loadAlerts();
    const poll = setInterval(loadAlerts, ALERTS_POLL_MS);
    return () => clearInterval(poll);
  }, [session, loadAlerts]);

  const updateAlerts = useCallback(async (patch) => {
    setAlertState((s) => ({ ...s, saving: true }));
    try {
      const body = await saveAlertsPrefs(patch);
      setAlertState((s) => ({ ...s, preferences: body.preferences, saving: false, error: null }));
    } catch (err) {
      setAlertState((s) => ({ ...s, saving: false, error: err.message }));
    }
  }, []);

  function setEnabled(enabled) {
    updateAlerts({ ...alertState.preferences, enabled });
  }

  function setDefaultLeadMin(defaultLeadMin) {
    updateAlerts({ ...alertState.preferences, defaultLeadMin });
  }

  function setCurrencyLead(currency, lead) {
    const currencies = { ...(alertState.preferences?.currencies || {}) };
    if (lead) currencies[currency] = lead;
    else delete currencies[currency];
    updateAlerts({ ...alertState.preferences, currencies });
  }

  function openSettings() {
    if (!session) {
      setAuthOpen(true);
      return;
    }
    setBotModal({ botToken: '', chatId: '', busy: false, error: null, result: null });
    setSettingsView('menu');
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
  }

  // After a successful login, drop straight into the Telegram Bot setup view
  // so the user can connect their bot immediately (no extra clicks).
  useEffect(() => {
    if (pendingSettings && session) {
      setPendingSettings(false);
      setBotModal({ botToken: '', chatId: '', busy: false, error: null, result: null });
      setSettingsView('bot');
      setSettingsOpen(true);
    }
  }, [pendingSettings, session]);

  function handleAuthed() {
    setPendingSettings(true);
  }

  async function submitBot() {
    setBotModal((m) => ({ ...m, busy: true, error: null, result: null }));
    try {
      const body = await saveAlertsBot(botModal.botToken.trim(), botModal.chatId.trim());
      setBotModal((m) => ({
        ...m,
        busy: false,
        result: body.channel?.configured
          ? `${body.channel?.name || 'Telegram'} connected — check your Telegram for a test message.`
          : 'Bot disconnected.',
      }));
      await loadAlerts();
    } catch (err) {
      setBotModal((m) => ({ ...m, busy: false, error: err.message }));
    }
  }

  return (
    <div className="board">
      <header className="board__header">
        <h1 className="board__title">
          MACRO BOARD <small>economic calendar for crypto &amp; forex traders</small>
        </h1>
        <div className="board__clock">
          {new Intl.DateTimeFormat(undefined, {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(now)}
        </div>
        <div className="board__account">
          {!isAuthConfigured ? null : authChecked && !session ? (
            <button className="account-btn" onClick={() => setAuthOpen(true)} type="button">
              Log in
            </button>
          ) : session ? (
            <div className="account-chip">
              <span className="account-chip__email" title={session.user.email}>
                {session.user.user_metadata?.full_name || session.user.email}
              </span>
              <button className="account-chip__logout" onClick={logout} type="button">
                Log out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="ticker">
        <span className="ticker__dot" />
        <span className="ticker__label">NEXT HIGH IMPACT</span>
        {nextHighImpact ? (
          <>
            <span className="ticker__body">
              {nextHighImpact.currency} — {nextHighImpact.title}
            </span>
            <span className="ticker__countdown">
              {formatCountdown(new Date(nextHighImpact.time).getTime() - now.getTime())}
            </span>
          </>
        ) : (
          <span className="ticker__body">No more high-impact events in range</span>
        )}
      </div>

      <div className="board__body">
        <aside className="rail">
          <div className="rail__group">
            <h2>Range</h2>
            <div className="rail__range">
              <button data-active={range === 'today'} onClick={() => setRange('today')}>
                Today
              </button>
              <button data-active={range === 'week'} onClick={() => setRange('week')}>
                This week
              </button>
            </div>
          </div>

          <div className="rail__group">
            <h2>Impact</h2>
            <div className="check-list">
              {IMPACT_LEVELS.map((level) => (
                <label key={level}>
                  <input
                    type="checkbox"
                    checked={selectedImpacts.has(level)}
                    onChange={() => toggleImpact(level)}
                  />
                  <span className={`impact-swatch impact-swatch--${level}`} />
                  {level[0].toUpperCase() + level.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {allCurrencies.length > 0 && (
            <div className="rail__group">
              <h2>Currency</h2>
              <div className="check-list">
                {allCurrencies.map((code) => (
                  <label key={code}>
                    <input
                      type="checkbox"
                      checked={!excludedCurrencies.has(code)}
                      onChange={() => toggleCurrency(code)}
                    />
                    {code}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="rail__group rail__settings">
            {!session ? (
              <div className="settings-lock" title="Log in to configure alerts">
                <button className="settings-btn settings-btn--locked" onClick={openSettings} type="button">
                  🔒 Log in for settings
                </button>
              </div>
            ) : (
              <button className="settings-btn" onClick={openSettings} type="button">
                ⚙ Settings
              </button>
            )}
          </div>
        </aside>

        <main className="main">
          {meta?.warning && meta?.stale && (
            <div className="status-banner status-banner--info">
              Calendar showing recent cached data — refreshing shortly.
            </div>
          )}
          {error && !meta && (
            <div className="status-banner status-banner--error">
              Couldn't load the calendar: {error}
            </div>
          )}

{loading && events.length === 0 && (
            <div className="empty-state">Loading board.</div>
          )}

          {!loading && filteredEvents.length === 0 && !error && (
            <div className="empty-state">
              No events match your filters{range === 'today' ? ' for today' : ' this week'}.
            </div>
          )}

          {grouped.length > 0 && (
            <div className="col-headers">
              <span>Time</span>
              <span>Ccy</span>
              <span />
              <span>Event</span>
              <span>Forecast</span>
              <span>Previous</span>
              <span>Actual</span>
            </div>
          )}

          {grouped.map(([label, rows]) => (
            <section key={label}>
              <div className="day-group__label">{label}</div>
              {rows.map((e) => {
                const actualNum = parseNum(e.actual);
                const forecastNum = parseNum(e.forecast);
                let deltaClass = '';
                if (actualNum !== null && forecastNum !== null) {
                  if (actualNum > forecastNum) deltaClass = 'row__actual--up';
                  else if (actualNum < forecastNum) deltaClass = 'row__actual--down';
                }
                return (
                  <div className="row" key={e.id} onClick={() => setChartRow(e)} title="Click for price chart">
                    <span className="row__time">{timeLabel(e.time)}</span>
                    <span className="row__currency">{e.currency}</span>
                    <span className={`row__impact impact-swatch--${e.impact}`} />
                    <span className="row__title" title={e.title}>
                      {e.title}
                    </span>
                    <span className="row__forecast">{e.forecast ?? '—'}</span>
                    <span className="row__previous">{e.previous ?? '—'}</span>
                    <span className={`row__actual ${deltaClass}`}>{e.actual ?? '—'}</span>
                  </div>
                );
              })}
            </section>
          ))}
        </main>
      </div>

      <footer className="board__footer">
        <span className="board__credit">
          <a
            className="board__credit-link"
            href="https://x.com/Anbu_maity"
            target="_blank"
            rel="noreferrer"
            title="Anbu on X"
          >
            Made by Anbu
          </a>
          <span className="board__credit-sep">·</span>
          <span className="board__credit-meta">
            Updated {formatRelative(meta?.fetchedAt)} · Unofficial data, not affiliated
            with Forex Factory. Not financial advice.
          </span>
        </span>
        <button className="refresh-btn" onClick={() => load(range)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </footer>

      {settingsOpen && (
        <div className="modal-overlay" onClick={closeSettings}>
          <div className="modal modal--settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal__head">
              {settingsView !== 'menu' && (
                <button
                  className="settings-back"
                  onClick={() => setSettingsView('menu')}
                  type="button"
                  aria-label="Back to settings menu"
                >
                  ←
                </button>
              )}
              <h3>
                {settingsView === 'menu'
                  ? 'Settings'
                  : SETTINGS_SECTIONS.find((s) => s.id === settingsView)?.label || 'Settings'}
              </h3>
              <button className="modal__close" onClick={closeSettings} type="button" aria-label="Close">
                ×
              </button>
            </div>

            {settingsView === 'menu' && (
              <div className="settings-menu">
                {SETTINGS_SECTIONS.map((s) => (
                  <button
                    key={s.id}
                    className="settings-menu__item"
                    onClick={() => setSettingsView(s.id)}
                    type="button"
                  >
                    <span className="settings-menu__icon">{s.icon}</span>
                    <span className="settings-menu__body">
                      <span className="settings-menu__label">{s.label}</span>
                      <span className="settings-menu__desc">{s.desc}</span>
                    </span>
                    <span className="settings-menu__arrow">›</span>
                  </button>
                ))}
                <div className="settings-menu__hint">More features coming soon.</div>
              </div>
            )}

            {settingsView === 'bot' && (
              <div className="modal__section">
                <h4 className="modal__section-title">Connect your bot</h4>

                <ol className="modal__steps">
                  <li>
                    Message <strong>@BotFather</strong> on Telegram and run{' '}
                    <code>/newbot</code> to create a bot. Copy the token it gives you.
                  </li>
                  <li>
                    Message your new bot anything (e.g. “hi”), then open{' '}
                    <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> and copy the
                    numeric <code>chat.id</code>.
                  </li>
                </ol>

                <label className="modal__label">
                  Bot token
                  <input
                    type="password"
                    value={botModal.botToken}
                    onChange={(e) => setBotModal((m) => ({ ...m, botToken: e.target.value, error: null, result: null }))}
                    placeholder="123456:ABC-DEF…"
                    autoComplete="off"
                    spellCheck="false"
                  />
                </label>

                <label className="modal__label">
                  Chat ID
                  <input
                    type="text"
                    value={botModal.chatId}
                    onChange={(e) => setBotModal((m) => ({ ...m, chatId: e.target.value, error: null, result: null }))}
                    placeholder="123456789"
                    autoComplete="off"
                    spellCheck="false"
                  />
                </label>

                {botModal.error && <div className="modal__error">{botModal.error}</div>}
                {botModal.result && (
                  <div className="modal__success">{botModal.result}</div>
                )}

                <div className="modal__actions">
                  <button
                    className="modal__save"
                    onClick={submitBot}
                    disabled={botModal.busy || !botModal.botToken.trim() || !botModal.chatId.trim()}
                    type="button"
                  >
                    {botModal.busy ? 'Checking…' : 'Save & test'}
                  </button>
                </div>

                <div className={`alerts__status ${alertState.server?.channelConfigured && alertState.preferences?.enabled ? '' : 'alerts__status--muted'}`}>
                  {alertState.server?.channelConfigured
                    ? alertState.preferences?.enabled
                      ? `${alertState.server.botName || 'Telegram'} · ON`
                      : 'Telegram connected · paused'
                    : 'Telegram not configured'}
                </div>
              </div>
            )}

            {settingsView === 'prefs' && (
              <div className="modal__section">
                <h4 className="modal__section-title">Alert preferences</h4>

                {alertState.status === 'error' && (
                  <div className="alerts__error">{alertState.error}</div>
                )}

                {alertState.status === 'loading' && (
                  <div className="alerts__hint">Loading…</div>
                )}

                {alertState.status === 'ready' && alertState.preferences && (
                  <>
                    <label className="alerts__toggle-label">
                      <input
                        type="checkbox"
                        checked={!!alertState.preferences.enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                        disabled={!alertState.server?.enabled || alertState.saving}
                      />
                      Send alerts
                    </label>
                    {!alertState.server?.enabled && (
                      <div className="alerts__hint">
                        Enable <code>ALERTS_ENABLED=true</code> on the server first.
                      </div>
                    )}

                    <label className="alerts__label">
                      Default lead time
                      <select
                        value={alertState.preferences.defaultLeadMin}
                        onChange={(e) => setDefaultLeadMin(Number(e.target.value))}
                        disabled={!alertState.server?.enabled || alertState.saving}
                      >
                        {LEAD_OPTIONS.map((m) => (
                          <option key={m} value={m}>
                            {m} min
                          </option>
                        ))}
                      </select>
                    </label>

                    {allCurrencies.length > 0 && (
                      <label className="alerts__label">
                        Per-currency override
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) setCurrencyLead(e.target.value, alertState.preferences.defaultLeadMin);
                          }}
                          disabled={!alertState.server?.enabled || alertState.saving}
                        >
                          <option value="">Add override…</option>
                          {allCurrencies
                            .filter((c) => !(alertState.preferences.currencies || {})[c])
                            .map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}

                    {Object.entries(alertState.preferences.currencies || {}).length > 0 && (
                      <div className="alerts__overrides">
                        {Object.entries(alertState.preferences.currencies || {}).map(([ccy, lead]) => (
                          <div className="alerts__override" key={ccy}>
                            <span>{ccy}</span>
                            <select
                              value={lead}
                              onChange={(e) => setCurrencyLead(ccy, Number(e.target.value) || 0)}
                              disabled={!alertState.server?.enabled || alertState.saving}
                            >
                              {LEAD_OPTIONS.map((m) => (
                                <option key={m} value={m}>
                                  {m}m
                                </option>
                              ))}
                              <option value={0}>—</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {chartRow && <ChartModal row={chartRow} onClose={() => setChartRow(null)} />}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} onAuthed={handleAuthed} />}
    </div>
  );
}
