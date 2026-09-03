import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, getDb } from './db.js';
import { getPrices } from './prices.js';
import { isAuthConfigured, verifySupabaseToken } from './auth.js';
import {
  startAlertScheduler,
  getUserAlertsStatus,
  setUserPreferences,
  setUserBotCredentials,
  SUPPORTED_LEAD_MIN,
} from './alerts.js';

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 240_000);
const JBLANKED_API_KEY = process.env.JBLANKED_API_KEY || '';
const ALERTS_ENABLED = String(process.env.ALERTS_ENABLED || '').toLowerCase() === 'true';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const JBLANKED_URL = 'https://www.jblanked.com/news/api/forex-factory/calendar/week/';

// ---------------------------------------------------------------------------
// In-memory cache. There is only ONE underlying dataset (the current week);
// "today" is just a filtered view of it. This means every client request,
// regardless of range, shares a single upstream fetch budget.
// ---------------------------------------------------------------------------
let cache = {
  events: null, // normalized events array
  source: null, // 'Forex Factory' | 'JBlanked (mirrors Forex Factory)' | 'Persistent history...'
  fetchedAt: null, // Date
  stale: false, // true when serving fallback/old data
  warning: null, // human-readable note about data freshness
};
let inFlight = null; // dedupe concurrent refreshes

function impactToLevel(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('med')) return 'medium';
  if (s.includes('low')) return 'low';
  if (s.includes('holiday') || s.includes('non-economic') || s.includes('none')) return 'holiday';
  return 'low';
}

function cleanValue(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '' || s.toLowerCase() === 'none') return null;
  return s;
}

function makeId(parts) {
  return parts.join('|').replace(/\s+/g, '_').toLowerCase();
}

// --- Forex Factory (unofficial weekly export) -------------------------------
async function fetchFromForexFactory() {
  const res = await fetch(FF_URL, {
    headers: { Accept: 'application/json' },
  });
  const text = await res.text();

  // FF returns an HTML "Request Denied" page (not JSON) once you're rate
  // limited, so a failed JSON.parse is our real signal to fall back.
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Forex Factory feed returned non-JSON (likely rate-limited or blocked)');
  }
  if (!Array.isArray(raw)) throw new Error('Forex Factory feed returned an unexpected shape');

  const events = raw.map((e) => ({
    id: makeId([e.title, e.country, e.date]),
    time: new Date(e.date).toISOString(),
    currency: e.country || '—',
    title: e.title || 'Untitled event',
    impact: impactToLevel(e.impact),
    forecast: cleanValue(e.forecast),
    previous: cleanValue(e.previous),
    actual: cleanValue(e.actual),
  }));

  return { events, source: 'Forex Factory' };
}

// --- JBlanked (fallback mirror) ---------------------------------------------
function parseJBlankedDate(s) {
  // Format: "2024.02.08 15:30:00" — no explicit timezone in the docs example.
  // We treat it as-is (server-local interpretation). If your deployment is in
  // a different timezone than JBlanked's source, adjust with their `offset`
  // query param — see their docs for the GMT-3/GMT/EST/PST offsets.
  const [datePart, timePart] = String(s).split(' ');
  if (!datePart) return new Date().toISOString();
  const iso = `${datePart.replace(/\./g, '-')}T${timePart || '00:00:00'}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function fetchFromJBlanked() {
  if (!JBLANKED_API_KEY) throw new Error('No JBLANKED_API_KEY configured');

  const res = await fetch(JBLANKED_URL, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Api-Key ${JBLANKED_API_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`JBlanked responded ${res.status}: ${body.slice(0, 200)}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('JBlanked returned an unexpected shape');

  const events = raw.map((e) => ({
    id: makeId([e.Name, e.Currency, e.Date]),
    time: parseJBlankedDate(e.Date),
    currency: e.Currency || '—',
    title: e.Name || 'Untitled event',
    impact: impactToLevel(e.Impact),
    forecast: cleanValue(e.Forecast),
    previous: cleanValue(e.Previous),
    actual: cleanValue(e.Actual),
  }));

  return { events, source: 'JBlanked (mirrors Forex Factory)' };
}

// --- Cache orchestration -----------------------------------------------------
// Rate-limit backoff. Forex Factory allows ~2 requests / 5 min per IP and
// returns an HTML "Request Denied" page (parsed as non-JSON) once you exceed
// it. Hammering it on every cache TTL keeps the block alive forever, so after
// a failed refresh we go quiet for FF_BACKOFF_MS and serve cached/history data
// instead of retrying.
const FF_BACKOFF_MS = Number(process.env.FF_BACKOFF_MS || 10 * 60_000);
let nextFetchAllowedAt = 0; // epoch ms; 0 = no backoff active

function inBackoff() {
  return Date.now() < nextFetchAllowedAt;
}

async function serveFallback(reason) {
  if (cache.events && cache.events.length) {
    cache = { ...cache, stale: true, warning: reason };
    return { ...cache };
  }
  // Last resort: serve our own persistent history. FF's feed changes to a
  // new week every week, so cap it to the last 8 days to stay relevant.
  // NOTE: don't reset fetchedAt here — if we did, the cache TTL would keep
  // extending and the backoff would never expire, so the server would never
  // retry the live source. Keeping the original timestamp means requests fall
  // through to refreshCache() once the cooldown passes.
  try {
    const db = await getDb();
    const since = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const historic = await db.loadRecentEvents(since);
    if (historic.length) {
      cache = {
        events: historic,
        source: 'Persistent history (last good snapshot)',
        stale: true,
        warning: reason,
      };
      return { ...cache };
    }
  } catch (histErr) {
    console.warn('[macro-board] history fallback failed:', histErr.message);
  }
  throw new Error(reason);
}

async function persistEvents(events, source) {
  try {
    const db = await getDb();
    // Upsert the whole fetch. The feed grows and mutates through the week, so
    // using a max-time watermark misses events that appeared between a partial
    // first fetch and a later one. ~100 rows every refresh is cheap, and
    // re-upserting lets the eventual `actual` values backfill into history.
    const withSource = events.map((e) => ({ ...e, source: source || null }));
    if (withSource.length) await db.upsertEvents(withSource);
  } catch (err) {
    console.warn('[macro-board] persist events failed:', err.message);
  }
}

async function refreshCache() {
  // During a cooldown, don't touch the upstream at all — just serve what we
  // have (fresh cache, stale cache, or stored history).
  if (inBackoff()) {
    return serveFallback(
      'Upstream rate-limited; retrying after the cooldown period. Showing the most recent data we have.'
    );
  }

  try {
    const result = await fetchFromForexFactory();
    nextFetchAllowedAt = 0; // success resets any backoff
    cache = { ...result, fetchedAt: new Date(), stale: false, warning: null };
    await persistEvents(cache.events, cache.source);
    return { ...cache };
  } catch (ffErr) {
    console.warn('[macro-board] Forex Factory fetch failed:', ffErr.message);
    try {
      const result = await fetchFromJBlanked();
      nextFetchAllowedAt = 0;
      cache = { ...result, fetchedAt: new Date(), stale: false, warning: null };
      await persistEvents(cache.events, cache.source);
      return { ...cache };
    } catch (jbErr) {
      console.warn('[macro-board] JBlanked fallback failed:', jbErr.message);
      // Both sources failed — back off before hitting the upstream again.
      nextFetchAllowedAt = Date.now() + FF_BACKOFF_MS;
      const reason = `Both live sources failed (${ffErr.message}${JBLANKED_API_KEY ? `; ${jbErr.message}` : '; no JBlanked API key configured'}). Retrying in ${Math.round(FF_BACKOFF_MS / 60000)} min. Showing the most recent data we have.`;
      return serveFallback(reason);
    }
  }
}

function getCachedEvents() {
  return cache.events || [];
}

async function getCalendar() {
  const age = cache.fetchedAt ? Date.now() - cache.fetchedAt.getTime() : Infinity;
  if (cache.events && age < CACHE_TTL_MS) {
    return { ...cache };
  }
  // Dedupe concurrent refreshes so a burst of client requests only triggers
  // one upstream fetch.
  if (!inFlight) {
    inFlight = refreshCache().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

// ---------------------------------------------------------------------------
const app = express();
app.use(
  cors(
    ALLOWED_ORIGINS.length
      ? { origin: ALLOWED_ORIGINS }
      : { origin: [/^http:\/\/localhost:\d+$/] }
  )
);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
});

// Optional auth: attaches req.user when a valid Supabase JWT is provided.
app.use(async (req, res, next) => {
  if (!isAuthConfigured()) return next();
  const header = req.headers.authorization;
  if (!header || !/^Bearer\s+/i.test(header)) return next();
  try {
    req.user = await verifySupabaseToken(header);
  } catch {
    req.user = null;
  }
  next();
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    configured: isAuthConfigured(),
    user: req.user || null,
  });
});

app.get('/api/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  res.json({ user: req.user });
});

// Protected: requires a valid signed-in session.
function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in required' });
  }
  next();
}

app.get('/api/calendar', async (req, res) => {
  const range = req.query.range === 'today' ? 'today' : 'week';
  try {
    const result = await getCalendar();
    let events = result.events;

    if (range === 'today') {
      const today = new Date();
      events = events.filter((e) => {
        const d = new Date(e.time);
        return (
          d.getUTCFullYear() === today.getUTCFullYear() &&
          d.getUTCMonth() === today.getUTCMonth() &&
          d.getUTCDate() === today.getUTCDate()
        );
      });
    }

    events = [...events].sort((a, b) => new Date(a.time) - new Date(b.time));

    res.json({
      events,
      meta: {
        source: result.source,
        fetchedAt: result.fetchedAt,
        stale: result.stale,
        warning: result.warning,
        range,
      },
    });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// --- Market prices (chart popup) ----------------------------------------------
// Live OHLC from Binance's public endpoint. Symbol is user-editable on the
// client (BTCUSDT, EURUSDT, ...) so forex pairs work once they exist on an
// upstream feed too — the component contract is just { time, open, high, low,
// close } candles backed by this route.
app.get('/api/prices', async (req, res) => {
  try {
    const result = await getPrices(req.query.symbol, req.query.range);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Alerts / preferences -----------------------------------------------------
// Requires login: the Telegram bot + alert preferences are personal settings.
app.use('/api/alerts/prefs', requireUser);
app.use('/api/alerts/bot', requireUser);

app.get('/api/alerts/prefs', async (req, res) => {
  try {
    const status = await getUserAlertsStatus(req.user.id);
    res.json({ preferences: status.preferences, channel: status.channel, server: status.server });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/prefs', async (req, res) => {
  try {
    const body = req.body || {};
    const status = await setUserPreferences(req.user.id, body);
    res.json({ ok: true, preferences: status.preferences });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate + activate THIS user's Telegram bot from the in-app setup modal.
// The bot token is validated server-side via Telegram's getMe and then stored
// per-user. The token itself is never sent back to the client.
app.post('/api/alerts/bot', async (req, res) => {
  try {
    const { botToken, chatId } = req.body || {};
    const status = await setUserBotCredentials(req.user.id, botToken, chatId);
    res.json({ ok: true, channel: status.channel });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[macro-board] API listening on http://localhost:${PORT}`);
  if (!JBLANKED_API_KEY) {
    console.log('[macro-board] No JBLANKED_API_KEY set — fallback source is disabled.');
  }

  try {
    await initDb();
    const db = await getDb();
    console.log(`[macro-board] history store ready (${db.kind})`);

    // Warm the cache so the alert scheduler has data even if no client hits /api/calendar yet.
    getCalendar().catch((err) => console.warn('[macro-board] initial warm-up failed:', err.message));

    if (ALERTS_ENABLED) {
      startAlertScheduler(getCachedEvents, (err) => {
        console.warn('[alerts]', err.message);
      });
    } else {
      console.log('[macro-board] alerts disabled (set ALERTS_ENABLED=true to enable).');
    }
  } catch (err) {
    console.error('[macro-board] init failed:', err);
  }
});
