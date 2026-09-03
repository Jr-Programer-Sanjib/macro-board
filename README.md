# Macro Board

A departure-board-style economic calendar dashboard, built to help crypto/forex
traders keep an eye on the macro events (CPI, NFP, rate decisions, etc.) that
tend to move markets.

**Data sources:** Forex Factory has no official public API, so this app uses
their unofficial weekly calendar export as the primary source, and falls back
to [JBlanked's Calendar API](https://www.jblanked.com/news/api/docs/calendar/)
(which mirrors Forex Factory, MQL5, and FxStreet) if that's unreachable or
rate-limited. Neither is affiliated with Forex Factory — treat this as
unofficial, best-effort data, not a trading signal.

Forex Factory itself is a **forex economic calendar**, not a crypto-native
news source — it won't show you exchange listings, hacks, or on-chain events.
What it's good for is the macro releases that move crypto indirectly (Fed
decisions, CPI, jobs data, etc.).

## Project layout

```
macro-board/
├── server/   Express API — fetches, normalizes, caches calendar data,
│             persists history, and fires Telegram alerts before high-impact events
└── client/   React (Vite) dashboard — board + alerts settings
```

Why a backend at all? Three reasons:
1. Forex Factory's export endpoint is rate-limited (~2 requests/5 min per IP)
   and blocks a lot of browser-origin requests — a server-side cache avoids
   both problems.
2. If you add a JBlanked API key, it needs to stay off the client — the
   backend is what keeps it secret.
3. The alert scheduler has to run server-side (it fires Telegram messages
   whether or not your dashboard is open), and the persistent event history
   needs a home that survives restarts.

## Alerts (Telegram)

Get pinged before high-impact events, so you don't have to keep the dashboard
open.

**Two ways to set up the bot:**

**A. In-app (easy):** open the dashboard → **Alerts** panel → **Set up bot**.
Paste your bot token and chat ID into the modal. The server validates the
token against Telegram, sends you a one-time confirmation message, and saves
the credentials (persisted, so restarts keep them).

**B. Via `server/.env`:**
```
ALERTS_ENABLED=true
TELEGRAM_BOT_TOKEN=<your token>
TELEGRAM_CHAT_ID=<your numeric chat id>
```

To create a bot:
1. Message [@BotFather](https://t.me/BotFather) on Telegram and use
   `/newbot` to create one. Copy the token it gives you.
2. Message your new bot anything (e.g. "hi"), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read the
   `chat.id` value.

Then, in the **Alerts** panel:
- Flip "Send alerts" on.
- Pick a default lead time (5 / 15 / 30 min).
- Add per-currency overrides (e.g. alert on USD 5 min before, EUR 30 min
  before). Events with no override use the default.

The scheduler checks the cached calendar every minute and sends exactly one
message per high-impact event, `N` minutes before it fires. Preferences are
persisted to the history store, so they survive restarts.

## Persistent history

Every fetched event (ID, time, currency, title, impact, forecast, previous,
eventual `actual`, source) is stored so nothing is lost on restart.

- By default this uses a **local SQLite file** at `server/data/macro-board.db`
  (Node's built-in driver — nothing to install). It survives restarts and is
  gitignored.
- To use **Postgres** instead (Supabase, Neon, any PG), set `DATABASE_URL` to
  your connection string. Tables are created automatically on boot.

This history is what a future "how did price move after past CPI beats/misses"
view would read from.

## Run it locally

**1. Backend**
```bash
cd server
cp .env.example .env      # optionally add JBLANKED_API_KEY, Telegram/alerts, DATABASE_URL
npm install
npm run dev                # http://localhost:8787
```

**2. Frontend** (in a second terminal)
```bash
cd client
npm install
npm run dev                # http://localhost:5173
```

Open http://localhost:5173 — the Vite dev server proxies `/api/*` requests to
the backend, so there's nothing else to configure locally.

## Deploying

**Backend** — Render (free) via `server/render.yaml`, or any always-on Node host:
- Set these secrets on the host (never in `.env.example`):
  - `DATABASE_TYPE=turso+supabase`
  - `TURSO_URL` + `TURSO_AUTH_TOKEN` (primary, from the Turso dashboard)
  - `SUPABASE_DATABASE_URL` (secondary Postgres, from Supabase Database → Connection)
  - `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (Supabase Auth, for JWT verification)
  - `ALLOWED_ORIGINS` (comma-separated) to your deployed frontend URL
  - `ALERTS_ENABLED=true`, `TELEGRAM_BOT_TOKEN`
- Start command is `npm start` (from `server/`). The host must keep the
  process alive for the alert scheduler (which reads all registered bot
  credentials from the DB and fires per configured user).
- **Free-tier caveat — run alerts 24/7 with an uptime pinger.** Render's free
  web service spins down after ~15 min of inactivity and only wakes on demand.
  The alert scheduler only runs while the process is alive, so on the free
  plan it will NOT fire 24/7 by itself. To keep it warm for free, use any
  scheduler that hits your health endpoint every few minutes. Cron-job.org is
  a good free option — full steps below.

### Keep the backend awake (24/7 alerts on Render's free plan)

1. On Render, after deploying the backend, grab your service URL.
   It ends in `/api/health`, e.g. `https://macro-board-api.onrender.com/api/health`.
   Confirm it returns `{ "ok": true, ... }` in a browser.

2. Create a free account at <https://cron-job.org>, then add a **new cron job**:
   - **Title:** `macro-board keep-alive`
   - **URL:** your backend's `/api/health` URL from step 1
   - **Execution schedule:** `*/5 * * * *` → every 5 minutes (interval must
     be **under 15 minutes**, otherwise Render still sleeps between pings)
   - **Method:** GET (the default)
   - **Save.** The job pings every 5 min, which prevents Render's idle timeout.

3. (Optional) Set **up-time monitoring / notification** in cron-job.org to email
   you if the endpoint ever goes down.

> **Why 5 minutes works:** Render sleeps after ~15 min idle. Pinging every 5
> min keeps the process warm, so the alert scheduler only misses at most the
> handful of seconds during a cold start/restart — not the whole night.
>
> **Caveat:** cron-job.org has a free-tier limit (currently ~10 min between
> jobs, and ~1,000 requests/day). `*/5 * * * *` = 288 requests/day, well under
> the limit. If your plan is capped tighter, use `*/10 * * * *` (144/day).
> Always double-check cron-job.org's current free-tier rules, since they change.
>
> **Truly always-on alternative:** a paid Render instance or an always-on plan
> has no idle time-out at all and never sleeps. The pinger gets you "good
> enough for free," not a hard 99.9% SLA.

**Frontend** — Vercel (free) from `client/` (see `client/vercel.json`):
- Set these build-time env vars on Vercel:
  - `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (public keys — safe
    to expose, but required for the client-side Supabase auth)
  - `VITE_API_BASE` (your deployed Render backend URL, e.g.
    `https://macro-board-api.onrender.com`). Relative `/api` calls work in dev
    via the Vite proxy; in production every call uses `VITE_API_BASE`.
- Build command `npm run build`, output `dist/`.

## Known limitations, honestly stated

- **Forex Factory's feed is unofficial.** The URL and rate limits have
  changed before and could change again without notice.
- **JBlanked's free tier is currently capped at 1 request/day.** It's wired
  up as a genuine fallback, but don't expect it to carry sustained traffic
  for free — check [their pricing](https://www.jblanked.com/api/billing/) if
  you need it as a real second source.
- **JBlanked's timestamps** don't specify a timezone in their docs; the
  server parses them as-is. If your event times look off by a few hours, use
  their `offset` parameter (documented on their site) to correct it.
- **"Actual vs. forecast" coloring is direction-only** (higher/lower than
  forecast), not a "bullish/bearish" call — whether a beat is good or bad
  for a given asset depends on the specific indicator, which this app
  doesn't try to guess.
- Holiday/no-impact calendar entries are filtered out of the board entirely
  (see `App.jsx`, `filteredEvents`) — remove that filter if you'd rather see
  them.
- **Alerts only fire while the server process is up.** The scheduler lives in
  the backend, so on a laptop you'd need the backend running for alerts to
  trigger; deploy it somewhere always-on for 24/7 alerts (see Deploying).
- **Per-user alerts** are stored in the `user_settings` table (Turso primary +
  Supabase mirror). Each signed-in user configures their own Telegram bot
  token + chat in Settings; the scheduler iterates them on each poll.
- **The bot token is a secret.** It's stored per-user in the history database
  and is never shown back through the API.

## Customizing

- Colors, fonts, and spacing are all CSS variables at the top of
  `client/src/index.css`.
- Poll interval (`POLL_MS`) and cache TTL (`CACHE_TTL_MS`) are separate knobs
  — the client polls its own backend, which only hits Forex Factory/JBlanked
  when its cache actually expires.
