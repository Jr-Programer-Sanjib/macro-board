# Macro Board — Deploy Checklist (free: Render + Vercel + cron-job)

Goal: free hosting so the backend runs 24/7 for Telegram alerts.

Stack:
- **Backend (API + alert scheduler):** Render free web service (`server/`)
- **Frontend (React/Vite):** Vercel free (`client/`)
- **Keep-alive:** cron-job.org pings `/api/health` so Render never goes idle
- **Auth:** Supabase (free) — JWT verified server-side
- **DB mirror:** Turso primary + Supabase Postgres secondary

---

## 0) Prereqs (already have)
- [ ] Supabase project URL + anon/publishable + secret/service keys
- [ ] Turso `TURSO_URL` (libsql://...) + `TURSO_AUTH_TOKEN`
- [ ] Supabase Postgres connection string (`SUPABASE_DATABASE_URL`)
- [ ] Telegram bot token from @BotFather (`TELEGRAM_BOT_TOKEN`)

---

## 1) Backend → Render

### Create the service
1. Push this repo to GitHub (see "First push" below).
2. On Render.com → **New → Blueprint**, connect the repo.
   - It reads `server/render.yaml` automatically.
   - Or **New → Web Service** and set manually:
     - Root directory: `server`
     - Build command: `npm install`
     - Start command: `npm start`
     - Plan: **Free**
3. After it provisions, copy the service URL.
   It looks like `https://macro-board-api.onrender.com`.
   Health check: `https://macro-board-api.onrender.com/api/health` → `{ "ok": true }`.

### Set env vars on Render (Dashboard → your service → Environment)
| Key | Value |
|---|---|
| `DATABASE_TYPE` | `turso+supabase` |
| `TURSO_URL` | your `libsql://...` URL |
| `TURSO_AUTH_TOKEN` | your Turso token |
| `SUPABASE_DATABASE_URL` | your Supabase Postgres connection string |
| `SUPABASE_URL` | your Supabase project URL (`https://xxxx.supabase.co`) |
| `SUPABASE_SECRET_KEY` | your Supabase **service_role/**secret key (server-side only) |
| `ALLOWED_ORIGINS` | comma-separated list of your Vercel frontend URL(s), e.g. `https://your-app.vercel.app` (**do NOT** leave blank in prod for security) |
| `ALERTS_ENABLED` | `true` |
| `TELEGRAM_BOT_TOKEN` | your bot token |
| `JBLANKED_API_KEY` | (optional) fallback data source |

Then **Deploy / Restart** the service.

> Local dev uses `ALLOWED_ORIGINS` blank → allows `localhost:*`. In prod,
> put your real Vercel URL so only your site can call the API.

---

## 2) Frontend → Vercel

1. On vercel.com → **New Project → Import** your repo.
2. Root folder: `client` (or the folder that contains `vite.config.js`).
3. Framework presets: Vercel should auto-detect **Vite**.
4. Set these **build/Environment Variables** before you Deploy:
   | Key | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your Supabase project URL |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | your Supabase **anon/publishable** key (safe to expose) |
   | `VITE_API_BASE` | your Render URL, e.g. `https://macro-board-api.onrender.com` |
5. Build command: `npm run build`. Output dir: `dist` (Vite default).
6. Deploy. Copy the Vercel URL, e.g. `https://macro-board.vercel.app`.

> `client/vercel.json` already sets framework/build/output + clean URLs.

---

## 3) Supabase — allow your sites

In Supabase Dashboard → **Authentication → URL Configuration**:
- Add to **Redirect URLs**:
  - `http://localhost:5173` (dev)
  - `https://your-app.vercel.app` (prod) — needed for login + password reset

> Without this, login/reset emails fail in the browser with a NetworkError.

---

## 4) Keep the backend awake (24/7 alerts on Render free)

Render free spins down after ~15 min idle. Fix with an uptime pinger:

1. Create a free account at **cron-job.org**.
2. **New cron job:**
   - Title: `macro-board keep-alive`
   - URL: `https://macro-board-api.onrender.com/api/health`
   - Schedule: `*/5 * * * *` (every 5 min — **must be < 15 min**)
   - Method: GET
   - Save.
3. Confirm it's hitting every 5 min in the job's history/log.
4. (Optional) Turn on email/Slack notification if the endpoint goes down.

> `*/5 * * * *` = 288 requests/day < cron-job free limit (~1000/day).
> If your plan is tighter use `*/10 * * * *` (144/day). Still < 15 min, so OK.

---

## 5) First push (before deploying!) — NO secrets in git

The real `.env` files are gitignored. The `.env.example` templates are clean
placeholders. Do NOT copy real keys into them.

```bash
cd D:\macro-board\macro-board
git add -A
git status              # confirm .env / .env.example clear to commit
git commit -m "Initial commit"
git remote add origin <your-github-url>
git push -u origin master
```

**Before pushing, verify:**
1. `git status` shows NO `server/.env` or `client/.env` staged.
2. `server/.env.example` + `client/.env.example` contain placeholders only.
3. No bot token / secret strings appear anywhere in tracked files.

---

## 6) Post-deploy smoke test

- [ ] Open Vercel URL → dashboard loads.
- [ ] Calendar loads (114-ish events).
- [ ] Open a chart (prices) → candles render.
- [ ] Sign up / log in → name shows in header.
- [ ] Settings → connect your Telegram bot → "connected" test message arrives.
- [ ] Set a small lead window (5 min) on a near-future high-impact event and
      confirm a Telegram alert fires.
- [ ] From a different browser/incognito, confirm `http://localhost:5173` still
      works in dev (localhost still allowed locally).

---

## Troubleshooting

| Problem | Likely fix |
|---|---|
| Logged-in user gets `NetworkError` on login/reset | Add the Vercel + localhost URLs to Supabase **Redirect URLs** (step 3) |
| `Not signed in` / 401 on settings | `SUPABASE_URL`/`SUPABASE_SECRET_KEY` not set, or token expired → re-login |
| Calendar slow / timeout | Forex Factory upstream is rate-limited/slow. It's cached 4 min server-side; retry or wait |
| Alerts don't arrive | Backend asleep (cron-job ping not set) OR alert window passed OR no bot configured for that user |
| CORS error in browser console | `ALLOWED_ORIGINS` on Render doesn't include your Vercel URL |
| Charts empty | Binance/Yahoo rate-limited; cached 60s. Check `/api/prices?symbol=EURUSD&range=1H` |

---

## Honest limits (free tier)
- **Uptime:** cron-job keeps it warm, but there's a brief cold-start on restart.
  A free service is "good enough", not a 99.9% SLA.
- **Upstream:** Forex Factory unofficial feed (~2 req / 5 min) — cached.
- **JBlanked fallback:** free tier ~1 request/day.
- **Worker concurrency:** single Node process is fine for hundreds of users;
  if you later need thousands + real reliability, consider a paid Render
  instance and/or a load balancer.
