import 'dotenv/config';
import { getDb } from './db.js';

const ALERTS_ENABLED = String(process.env.ALERTS_ENABLED || '').toLowerCase() === 'true';
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 60_000);
const ALERT_WINDOW_MS = Number(process.env.ALERT_WINDOW_MS || 4 * 60 * 60 * 1000); // watch 4h ahead

// Lead-time window checked within each poll. If an event lands inside one of
// the configured lead windows between two polls, we fire it exactly once.
const SUPPORTED_LEAD_MIN = [5, 15, 30];

const DEFAULT_PREFS = {
  enabled: false,
  channel: 'telegram',
  currencies: {}, // { "USD": 15, "EUR": 30 } — lead minutes per currency
  defaultLeadMin: 15,
};

// In-memory guard that prevents duplicate messages within this process
// (keyed by userId + event id + lead). The DB alert_log is the durable
// record across restarts.
const fired = new Set();

function normalizePrefs(raw) {
  const p = {
    enabled: !!raw?.enabled,
    channel: raw?.channel === 'ntfy' ? 'ntfy' : 'telegram',
    currencies: {},
    defaultLeadMin: SUPPORTED_LEAD_MIN.includes(Number(raw?.defaultLeadMin))
      ? Number(raw.defaultLeadMin)
      : 15,
  };
  if (raw?.currencies && typeof raw.currencies === 'object') {
    for (const [ccy, lead] of Object.entries(raw.currencies)) {
      if (SUPPORTED_LEAD_MIN.includes(Number(lead))) p.currencies[ccy] = Number(lead);
    }
  }
  return p;
}

function normalizeBot(raw) {
  return {
    botToken: String(raw?.botToken || ''),
    botChatId: String(raw?.botChatId || ''),
    name: String(raw?.name || ''),
  };
}

function botConfigured(bot) {
  return !!(bot && bot.botToken && bot.botChatId);
}

function leadMinFor(prefs, currency) {
  return prefs.currencies[currency] ?? prefs.defaultLeadMin;
}

// ---------------------------------------------------------------------------
// Per-user settings: the whole { prefs, bot } blob lives in one user_settings
// row keyed by the Supabase user id.
// ---------------------------------------------------------------------------
export async function getUserSettings(userId) {
  const db = await getDb();
  const row = await db.loadUserSettings(userId);
  if (!row) return null;
  return {
    prefs: normalizePrefs(row.prefs),
    bot: normalizeBot(row.bot),
  };
}

export async function saveUserSettings(userId, { prefs, bot }) {
  const db = await getDb();
  await db.saveUserSettings(userId, {
    prefs: normalizePrefs(prefs),
    bot: normalizeBot(bot),
  });
  return getUserSettings(userId);
}

export async function getUserAlertsStatus(userId) {
  const settings = (await getUserSettings(userId)) || { prefs: DEFAULT_PREFS, bot: { botToken: '', botChatId: '', name: '' } };
  return {
    preferences: settings.prefs,
    channel: { configured: botConfigured(settings.bot), name: botConfigured(settings.bot) ? settings.bot.name : null },
    server: {
      enabled: ALERTS_ENABLED,
      channelConfigured: botConfigured(settings.bot),
      botName: botConfigured(settings.bot) ? settings.bot.name : null,
      supportedLeadMin: SUPPORTED_LEAD_MIN,
    },
  };
}

export async function setUserPreferences(userId, next) {
  const settings = (await getUserSettings(userId)) || { prefs: DEFAULT_PREFS, bot: { botToken: '', botChatId: '', name: '' } };
  const prefs = normalizePrefs(next);
  await saveUserSettings(userId, { prefs, bot: settings.bot });
  return getUserAlertsStatus(userId);
}

// Validate a token against the Telegram API, send a one-time test message to
// confirm the chat ID delivers, then persist for THIS user only.
export async function setUserBotCredentials(userId, botTokenIn, botChatIdIn) {
  if (!botTokenIn || !String(botTokenIn).trim()) {
    const settings = (await getUserSettings(userId)) || { prefs: DEFAULT_PREFS, bot: { botToken: '', botChatId: '', name: '' } };
    await saveUserSettings(userId, {
      prefs: settings.prefs,
      bot: { botToken: '', botChatId: '', name: '' },
    });
    return getUserAlertsStatus(userId);
  }
  if (!botChatIdIn || !String(botChatIdIn).trim()) {
    throw new Error('Chat ID is required.');
  }

  const botToken = String(botTokenIn).trim();
  const botChatId = String(botChatIdIn).trim();

  // Validate the token by calling Telegram's getMe (no message sent).
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const desc = body?.description || `status ${res.status}`;
    throw new Error(`Telegram rejected that bot token (${desc}). Double-check it and try again.`);
  }
  const username = body.result?.username || '';
  const name = username ? `@${username}` : '';

  // Send a one-time confirmation. This proves the chat ID is correct.
  try {
    await sendTelegram(botToken, botChatId, '[macro-board] ✅ Bot connected — alerts will be delivered here.');
  } catch (err) {
    throw new Error(
      `The token is valid but I couldn't deliver a test message: ${err.message}. Double-check the Chat ID — it must be your numeric user id, not the bot's @username.`
    );
  }

  const settings = (await getUserSettings(userId)) || { prefs: DEFAULT_PREFS, bot: { botToken: '', botChatId: '', name: '' } };
  await saveUserSettings(userId, {
    prefs: settings.prefs,
    bot: { botToken, botChatId, name },
  });
  return getUserAlertsStatus(userId);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
function shouldFire(prefs, event, now) {
  const eventMs = new Date(event.time).getTime();
  const leadMs = leadMinFor(prefs, event.currency) * 60_000;

  const diff = eventMs - now;
  if (diff <= 0 || diff > ALERT_WINDOW_MS) return false;

  const crossed = diff <= leadMs;
  return crossed;
}

async function sendTelegram(botToken, botChatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: botChatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(
      `Telegram sendMessage failed (${res.status}): ${body?.description || JSON.stringify(body)}`
    );
  }
  return body;
}

function formatAlert(event, lead) {
  const at = new Date(event.time);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const when = at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return [
    `⚠️ HIGH IMPACT in ${lead}m`,
    ``,
    `${event.currency} — ${event.title}`,
    `🕒 ${when} ${hhmm}`,
    event.forecast ? `📊 Forecast: ${event.forecast}` : '',
    event.previous ? `🔵 Previous: ${event.previous}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function fire(db, userId, event, prefs, bot) {
  const lead = leadMinFor(prefs, event.currency);
  const id = `${userId}|${event.id}|${lead}`;

  const already = await db.alertExists(id);
  if (already) {
    fired.add(id);
    console.log(`[alerts] skip duplicate for ${userId} · ${event.currency} — ${event.title} (${lead}m lead)`);
    return;
  }

  await sendTelegram(bot.botToken, bot.botChatId, formatAlert(event, lead));
  await db.logAlert(id, Date.now(), lead, event.currency, event.title, prefs.channel);
  fired.add(id);
  console.log(`[alerts] sent Telegram alert for ${userId} · ${event.currency} — ${event.title} (${lead}m lead)`);
}

export async function startAlertScheduler(getEvents, onError) {
  if (!ALERTS_ENABLED) {
    console.log('[alerts] ALERTS_ENABLED=false — alert scheduler disabled.');
    return () => {};
  }

  // Wait until the server's warm-up fetch has populated the cache so the
  // first tick has real data to evaluate.
  let attempt = 0;
  const ensureData = async () => {
    const evs = getEvents();
    return Array.isArray(evs) && evs.length > 0;
  };
  while (!(await ensureData()) && attempt < 10) {
    await new Promise((r) => setTimeout(r, 1000));
    attempt += 1;
  }

  const tick = async () => {
    const now = Date.now();
    let events = [];
    try {
      events = getEvents();
    } catch (err) {
      onError?.(err);
      return;
    }
    if (!events || !events.length) return;

    const highs = events.filter((e) => e.impact === 'high');

    const db = await getDb();
    let users = [];
    try {
      users = (await db.loadAllUserSettings()).filter((u) => botConfigured(u.settings.bot));
    } catch (err) {
      onError?.(err);
      return;
    }

    for (const { userId, settings } of users) {
      if (!settings?.prefs?.enabled) continue;
      for (const ev of highs) {
        if (!shouldFire(settings.prefs, ev, now)) continue;
        try {
          await fire(db, userId, ev, settings.prefs, settings.bot);
        } catch (err) {
          onError?.(err);
          // Don't mark fired on failure so we retry next tick.
        }
      }
    }

    if (fired.size > 5000) fired.clear();
  };

  await tick();
  const timer = setInterval(tick, ALERT_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export { SUPPORTED_LEAD_MIN };