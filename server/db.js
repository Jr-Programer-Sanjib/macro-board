import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createClient as createLibsqlClient } from '@libsql/client';

const DATABASE_URL = process.env.DATABASE_URL || '';
const SQLITE_FILE = process.env.SQLITE_FILE || './data/macro-board.db';
const DATABASE_TYPE = String(process.env.DATABASE_TYPE || '').toLowerCase();
const TURSO_URL = process.env.TURSO_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

/** Secondary Postgres URL for "primary+secondary" mode (Supabase default). */
const SECONDARY_DATABASE_URL = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL || '';

/**
 * Storage layer for persistent event history and alert preferences.
 *
 * Backends, selected via DATABASE_TYPE:
 *  - sqlite               local file (default; zero setup, good for dev)
 *  - postgres|supabase    Supabase/Neon/any PG via the `pg` driver
 *  - turso                edge SQLite via @libsql/client (TURSO_URL + token)
 *  - A+B                  primary "A" + secondary "B", e.g. turso+supabase.
 *                         Writes go to both; reads come from the primary and
 *                         fail over to the secondary if it errors.
 *
 * If DATABASE_TYPE is blank: Postgres when DATABASE_URL is set, else SQLite.
 * If the requested backend(s) can't be built (missing URL), it logs a warning
 * and falls back to local SQLite so the app always runs.
 *
 * All expose the SAME async interface: { init, upsertEvents, lastEventTime,
 * loadRecentEvents, savePreferences, loadPreferences, getBotCredentials,
 * saveBotCredentials, logAlert, alertExists, close }.
 */

let backend = null; // resolved store object

// ---------------------------------------------------------------------------
// SQLite backend (Node built-in)
// ---------------------------------------------------------------------------
function createSqliteStore(file = SQLITE_FILE) {
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      time_ms INTEGER NOT NULL,
      currency TEXT NOT NULL,
      title TEXT NOT NULL,
      impact TEXT NOT NULL,
      forecast TEXT,
      previous TEXT,
      actual TEXT,
      source TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_currency ON events (currency);
    CREATE INDEX IF NOT EXISTS idx_events_time ON events (time_ms);

    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_log (
      id TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL,
      lead_min INTEGER NOT NULL,
      currency TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const stmtUpsert = db.prepare(`
    INSERT INTO events (id, time_ms, currency, title, impact, forecast, previous, actual, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      actual      = COALESCE(excluded.actual, events.actual),
      forecast    = COALESCE(excluded.forecast, events.forecast),
      previous    = COALESCE(excluded.previous, events.previous),
      source      = COALESCE(excluded.source, events.source),
      updated_at  = excluded.updated_at
  `);
  const stmtGetMax = db.prepare('SELECT COALESCE(MAX(time_ms), 0) AS m FROM events');
  const stmtLogInsert = db.prepare('INSERT OR IGNORE INTO alert_log VALUES (?, ?, ?, ?, ?, ?)');

  return {
    kind: 'sqlite',
    async init() {
      // no-op, schema created in constructor
    },
    async upsertEvents(events) {
      const now = Date.now();
      for (const e of events) {
        stmtUpsert.run(
          e.id,
          new Date(e.time).getTime(),
          e.currency,
          e.title,
          e.impact,
          e.forecast ?? null,
          e.previous ?? null,
          e.actual ?? null,
          e.source ?? null,
          now
        );
      }
      return events.length;
    },
    async lastEventTime() {
      return Number(stmtGetMax.get().m);
    },
    async loadRecentEvents(sinceMs) {
      const rows = db
        .prepare('SELECT * FROM events WHERE time_ms >= ? ORDER BY time_ms')
        .all(sinceMs);
      return rows.map((r) => ({
        id: r.id,
        time: new Date(r.time_ms).toISOString(),
        currency: r.currency,
        title: r.title,
        impact: r.impact,
        forecast: r.forecast,
        previous: r.previous,
        actual: r.actual,
        source: r.source,
      }));
    },
    async savePreferences(obj) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO prefs (key, value, updated_at) VALUES ('main', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(obj), now);
    },
    async loadPreferences() {
      const row = db.prepare(`SELECT value FROM prefs WHERE key = 'main'`).get();
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    async getBotCredentials() {
      const row = db.prepare(`SELECT value FROM prefs WHERE key = 'bot'`).get();
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    async saveBotCredentials(creds) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO prefs (key, value, updated_at) VALUES ('bot', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(creds), now);
    },
    async logAlert(id, sentAt, leadMin, currency, title, channel) {
      stmtLogInsert.run(id, sentAt, leadMin, currency, title, channel);
    },
    async alertExists(id) {
      return !!db.prepare('SELECT 1 FROM alert_log WHERE id = ?').get(id);
    },
    async saveUserSettings(userId, obj) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO user_settings (user_id, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(userId, JSON.stringify(obj), now);
    },
    async loadUserSettings(userId) {
      const row = db.prepare(`SELECT value FROM user_settings WHERE user_id = ?`).get(userId);
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    },
    async loadAllUserSettings() {
      const rows = db.prepare(`SELECT user_id, value FROM user_settings`).all();
      return rows.map((r) => {
        try {
          return { userId: r.user_id, settings: JSON.parse(r.value) };
        } catch {
          return null;
        }
      }).filter(Boolean);
    },
    async close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------
function createPostgresStore(connectionString = DATABASE_URL) {
  const { Pool } = pg;
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          time_ms BIGINT NOT NULL,
          currency TEXT NOT NULL,
          title TEXT NOT NULL,
          impact TEXT NOT NULL,
          forecast TEXT,
          previous TEXT,
          actual TEXT,
          source TEXT,
          updated_at BIGINT NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_events_currency ON events (currency);
        CREATE INDEX IF NOT EXISTS idx_events_time ON events (time_ms);

        CREATE TABLE IF NOT EXISTS prefs (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alert_log (
          id TEXT PRIMARY KEY,
          sent_at BIGINT NOT NULL,
          lead_min INTEGER NOT NULL,
          currency TEXT NOT NULL,
          title TEXT NOT NULL,
          channel TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
    },
    async upsertEvents(events) {
      const now = Date.now();
      for (const e of events) {
        await pool.query(
          `INSERT INTO events (id, time_ms, currency, title, impact, forecast, previous, actual, source, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             actual     = COALESCE(EXCLUDED.actual, events.actual),
             forecast   = COALESCE(EXCLUDED.forecast, events.forecast),
             previous   = COALESCE(EXCLUDED.previous, events.previous),
             source     = COALESCE(EXCLUDED.source, events.source),
             updated_at = EXCLUDED.updated_at`,
          [e.id, new Date(e.time).getTime(), e.currency, e.title, e.impact, e.forecast ?? null, e.previous ?? null, e.actual ?? null, e.source ?? null, now]
        );
      }
      return events.length;
    },
    async lastEventTime() {
      const { rows } = await pool.query('SELECT COALESCE(MAX(time_ms), 0) AS m FROM events');
      return Number(rows[0].m);
    },
    async loadRecentEvents(sinceMs) {
      const { rows } = await pool.query(
        'SELECT * FROM events WHERE time_ms >= $1 ORDER BY time_ms',
        [sinceMs]
      );
      return rows.map((r) => ({
        id: r.id,
        time: new Date(Number(r.time_ms)).toISOString(),
        currency: r.currency,
        title: r.title,
        impact: r.impact,
        forecast: r.forecast,
        previous: r.previous,
        actual: r.actual,
        source: r.source,
      }));
    },
    async savePreferences(obj) {
      const now = Date.now();
      await pool.query(
        `INSERT INTO prefs (key, value, updated_at) VALUES ('main', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(obj), now]
      );
    },
    async loadPreferences() {
      const { rows } = await pool.query(`SELECT value FROM prefs WHERE key = 'main'`);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].value);
      } catch {
        return null;
      }
    },
    async getBotCredentials() {
      const { rows } = await pool.query(`SELECT value FROM prefs WHERE key = 'bot'`);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].value);
      } catch {
        return null;
      }
    },
    async saveBotCredentials(creds) {
      const now = Date.now();
      await pool.query(
        `INSERT INTO prefs (key, value, updated_at) VALUES ('bot', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(creds), now]
      );
    },
    async logAlert(id, sentAt, leadMin, currency, title, channel) {
      await pool.query(
        `INSERT INTO alert_log (id, sent_at, lead_min, currency, title, channel) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [id, sentAt, leadMin, currency, title, channel]
      );
    },
    async alertExists(id) {
      const { rows } = await pool.query('SELECT 1 FROM alert_log WHERE id = $1', [id]);
      return rows.length > 0;
    },
    async saveUserSettings(userId, obj) {
      const now = Date.now();
      await pool.query(
        `INSERT INTO user_settings (user_id, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [userId, JSON.stringify(obj), now]
      );
    },
    async loadUserSettings(userId) {
      const { rows } = await pool.query('SELECT value FROM user_settings WHERE user_id = $1', [userId]);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].value);
      } catch {
        return null;
      }
    },
    async loadAllUserSettings() {
      const { rows } = await pool.query('SELECT user_id, value FROM user_settings');
      return rows
        .map((r) => {
          try {
            return { userId: r.user_id, settings: JSON.parse(r.value) };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Turso (libSQL / edge SQLite) backend
// ---------------------------------------------------------------------------
function createTursoStore() {
  const db = createLibsqlClient({
    url: TURSO_URL,
    authToken: TURSO_AUTH_TOKEN || undefined,
  });

  return {
    kind: 'turso',
    async init() {
      await db.executeMultiple(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          time_ms INTEGER NOT NULL,
          currency TEXT NOT NULL,
          title TEXT NOT NULL,
          impact TEXT NOT NULL,
          forecast TEXT,
          previous TEXT,
          actual TEXT,
          source TEXT,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_events_currency ON events (currency);
        CREATE INDEX IF NOT EXISTS idx_events_time ON events (time_ms);

        CREATE TABLE IF NOT EXISTS prefs (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS alert_log (
          id TEXT PRIMARY KEY,
          sent_at INTEGER NOT NULL,
          lead_min INTEGER NOT NULL,
          currency TEXT NOT NULL,
          title TEXT NOT NULL,
          channel TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
    async upsertEvents(events) {
      const now = Date.now();
      for (const e of events) {
        await db.execute(
          `INSERT INTO events (id, time_ms, currency, title, impact, forecast, previous, actual, source, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             actual     = COALESCE(excluded.actual, events.actual),
             forecast   = COALESCE(excluded.forecast, events.forecast),
             previous   = COALESCE(excluded.previous, events.previous),
             source     = COALESCE(excluded.source, events.source),
             updated_at = excluded.updated_at`,
          [e.id, new Date(e.time).getTime(), e.currency, e.title, e.impact, e.forecast ?? null, e.previous ?? null, e.actual ?? null, e.source ?? null, now]
        );
      }
      return events.length;
    },
    async lastEventTime() {
      const { rows } = await db.execute('SELECT COALESCE(MAX(time_ms), 0) AS m FROM events');
      return Number(rows[0].m);
    },
    async loadRecentEvents(sinceMs) {
      const { rows } = await db.execute(
        'SELECT * FROM events WHERE time_ms >= ? ORDER BY time_ms',
        [sinceMs]
      );
      return rows.map((r) => ({
        id: r.id,
        time: new Date(Number(r.time_ms)).toISOString(),
        currency: r.currency,
        title: r.title,
        impact: r.impact,
        forecast: r.forecast,
        previous: r.previous,
        actual: r.actual,
        source: r.source,
      }));
    },
    async savePreferences(obj) {
      const now = Date.now();
      await db.execute(
        `INSERT INTO prefs (key, value, updated_at) VALUES ('main', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [JSON.stringify(obj), now]
      );
    },
    async loadPreferences() {
      const { rows } = await db.execute(`SELECT value FROM prefs WHERE key = 'main'`);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].value);
      } catch {
        return null;
      }
    },
    async getBotCredentials() {
      const { rows } = await db.execute(`SELECT value FROM prefs WHERE key = 'bot'`);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].value);
      } catch {
        return null;
      }
    },
    async saveBotCredentials(creds) {
      const now = Date.now();
      await db.execute(
        `INSERT INTO prefs (key, value, updated_at) VALUES ('bot', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [JSON.stringify(creds), now]
      );
    },
    async logAlert(id, sentAt, leadMin, currency, title, channel) {
      await db.execute(
        `INSERT INTO alert_log (id, sent_at, lead_min, currency, title, channel) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [id, sentAt, leadMin, currency, title, channel]
      );
    },
    async alertExists(id) {
      const { rows } = await db.execute('SELECT 1 FROM alert_log WHERE id = ?', [id]);
      return rows.length > 0;
    },
    async saveUserSettings(userId, obj) {
      const now = Date.now();
      await db.execute(
        `INSERT INTO user_settings (user_id, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [userId, JSON.stringify(obj), now]
      );
    },
    async loadUserSettings(userId) {
      const { rows } = await db.execute('SELECT value FROM user_settings WHERE user_id = ?', [userId]);
      if (!rows.length) return null;
      try {
        return JSON.parse(rows[0].value);
      } catch {
        return null;
      }
    },
    async loadAllUserSettings() {
      const { rows } = await db.execute('SELECT user_id, value FROM user_settings');
      return rows
        .map((r) => {
          try {
            return { userId: r.user_id, settings: JSON.parse(r.value) };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
    async close() {
      try {
        await db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Base store factory + primary/secondary mirror
// ---------------------------------------------------------------------------
function createBaseStore(type) {
  switch (type) {
    case 'turso':
      return TURSO_URL ? createTursoStore() : null;
    case 'postgres':
    case 'supabase':
      return SECONDARY_DATABASE_URL ? createPostgresStore(SECONDARY_DATABASE_URL) : null;
    case 'sqlite':
      return createSqliteStore();
    default:
      return null;
  }
}

/**
 * Writes to BOTH stores (primary first, secondary best-effort). Reads come
 * from the primary and fail over to the secondary if the primary errors.
 * `kind` reports the actual serving backend, e.g. `turso+supabase`.
 */
function createMirrorStore(primary, secondary) {
  const mirror = {
    kind: `${primary.kind}+${secondary.kind}`,
    async init() {
      await primary.init();
      try {
        await secondary.init();
      } catch (err) {
        console.warn('[macro-board] secondary store init failed (dual-writes will still be attempted):', err.message);
      }
    },
    async upsertEvents(events) {
      let wrote = false;
      try {
        await primary.upsertEvents(events);
        wrote = true;
      } catch (err) {
        console.warn('[macro-board] primary write failed, sending to secondary:', err.message);
      }
      try {
        await secondary.upsertEvents(events);
        wrote = true;
      } catch (err) {
        console.warn('[macro-board] secondary write failed:', err.message);
      }
      if (!wrote) throw new Error('both stores failed to persist events');
      return events.length;
    },
    async lastEventTime() {
      try {
        return await primary.lastEventTime();
      } catch (err) {
        console.warn('[macro-board] primary read failed, using secondary:', err.message);
        return secondary.lastEventTime();
      }
    },
    async loadRecentEvents(sinceMs) {
      try {
        return await primary.loadRecentEvents(sinceMs);
      } catch (err) {
        console.warn('[macro-board] primary read failed, using secondary:', err.message);
        return secondary.loadRecentEvents(sinceMs);
      }
    },
    async savePreferences(obj) {
      let wrote = false;
      try { await primary.savePreferences(obj); wrote = true; } catch (err) { console.warn('[macro-board] primary write failed, sending to secondary:', err.message); }
      try { await secondary.savePreferences(obj); wrote = true; } catch (err) { console.warn('[macro-board] secondary write failed:', err.message); }
      if (!wrote) throw new Error('both stores failed to save preferences');
    },
    async loadPreferences() {
      try { return await primary.loadPreferences(); } catch (err) { console.warn('[macro-board] primary read failed, using secondary:', err.message); return secondary.loadPreferences(); }
    },
    async getBotCredentials() {
      try { return await primary.getBotCredentials(); } catch (err) { console.warn('[macro-board] primary read failed, using secondary:', err.message); return secondary.getBotCredentials(); }
    },
    async saveBotCredentials(creds) {
      let wrote = false;
      try { await primary.saveBotCredentials(creds); wrote = true; } catch (err) { console.warn('[macro-board] primary write failed, sending to secondary:', err.message); }
      try { await secondary.saveBotCredentials(creds); wrote = true; } catch (err) { console.warn('[macro-board] secondary write failed:', err.message); }
      if (!wrote) throw new Error('both stores failed to save bot credentials');
    },
    async logAlert(id, sentAt, leadMin, currency, title, channel) {
      let wrote = false;
      try { await primary.logAlert(id, sentAt, leadMin, currency, title, channel); wrote = true; } catch (err) { console.warn('[macro-board] primary write failed, sending to secondary:', err.message); }
      try { await secondary.logAlert(id, sentAt, leadMin, currency, title, channel); wrote = true; } catch (err) { console.warn('[macro-board] secondary write failed:', err.message); }
      if (!wrote) throw new Error('both stores failed to record alert');
    },
    async alertExists(id) {
      try { return await primary.alertExists(id); } catch (err) { console.warn('[macro-board] primary read failed, using secondary:', err.message); return secondary.alertExists(id); }
    },
    async saveUserSettings(userId, obj) {
      let wrote = false;
      try { await primary.saveUserSettings(userId, obj); wrote = true; } catch (err) { console.warn('[macro-board] primary write failed, sending to secondary:', err.message); }
      try { await secondary.saveUserSettings(userId, obj); wrote = true; } catch (err) { console.warn('[macro-board] secondary write failed:', err.message); }
      if (!wrote) throw new Error('both stores failed to save user settings');
    },
    async loadUserSettings(userId) {
      try { return await primary.loadUserSettings(userId); } catch (err) { console.warn('[macro-board] primary read failed, using secondary:', err.message); return secondary.loadUserSettings(userId); }
    },
    async loadAllUserSettings() {
      try { return await primary.loadAllUserSettings(); } catch (err) { console.warn('[macro-board] primary read failed, using secondary:', err.message); return secondary.loadAllUserSettings(); }
    },
    async close() {
      try { await primary.close(); } catch { /* ignore */ }
      try { await secondary.close(); } catch { /* ignore */ }
    },
  };
  return mirror;
}

const warnAndFallback = (message) => {
  console.warn(`[macro-board] ${message}`);
  const sqlite = createSqliteStore();
  return sqlite;
};

export async function initDb() {
  if (backend) return backend;

  // "turso+supabase" primary/secondary mode — and any other A+B combination.
  if (DATABASE_TYPE.includes('+')) {
    const [a, b] = DATABASE_TYPE.split('+').map((s) => s.trim());
    const primary = createBaseStore(a);
    const secondary = createBaseStore(b);

    if (primary && secondary) {
      backend = createMirrorStore(primary, secondary);
      try {
        await backend.init();
        return backend;
      } catch (err) {
        console.warn(
          `[macro-board] primary store (${a}) init failed, falling back:`,
          err.message
        );
      }
      try {
        await primary.close();
      } catch {
        /* ignore */
      }
      backend = warnAndFallback(`unable to reach primary "${a}" — falling back to SQLite. Secondary "${b}" is not promoted automatically; check Turso credentials.`);
      await backend.init();
      return backend;
    }

    // One of the two isn't configured — fall back to whichever IS.
    if (primary) {
      backend = primary;
      await backend.init();
      console.warn(`[macro-board] secondary "${b}" not configured (missing URL) — running on primary "${a}" only.`);
      return backend;
    }
    if (secondary) {
      backend = secondary;
      await backend.init();
      console.warn(`[macro-board] primary "${a}" not configured (missing URL) — running on secondary "${b}" only.`);
      return backend;
    }
    backend = warnAndFallback(`neither "${a}" nor "${b}" configured (missing URLs) — falling back to SQLite.`);
    await backend.init();
    return backend;
  }

  // Single-backend mode with explicit type.
  if (DATABASE_TYPE && DATABASE_TYPE !== 'sqlite') {
    const store = createBaseStore(DATABASE_TYPE);
    if (store) {
      if (DATABASE_TYPE === 'supabase') store.kind = 'supabase';
      backend = store;
      try {
        await backend.init();
        return backend;
      } catch (err) {
        console.warn(`[macro-board] ${DATABASE_TYPE} init failed, falling back to SQLite:`, err.message);
        try {
          await backend.close();
        } catch {
          /* ignore */
        }
        backend = createSqliteStore();
        await backend.init();
        return backend;
      }
    }
    if (DATABASE_TYPE === 'postgres' || DATABASE_TYPE === 'supabase') {
      backend = warnAndFallback(`DATABASE_TYPE=${DATABASE_TYPE} but no Supabase/DATABASE_URL is set — falling back to SQLite.`);
      await backend.init();
      return backend;
    }
    if (DATABASE_TYPE === 'turso') {
      backend = warnAndFallback('DATABASE_TYPE=turso but TURSO_URL is missing — falling back to SQLite.');
      await backend.init();
      return backend;
    }
    backend = warnAndFallback(`Unknown DATABASE_TYPE "${DATABASE_TYPE}" — falling back to SQLite.`);
    await backend.init();
    return backend;
  }

  // Back-compat: DATABASE_URL alone means Postgres (Supabase/Neon/any PG).
  if (DATABASE_URL) {
    const store = createPostgresStore();
    backend = store;
    try {
      await backend.init();
      return backend;
    } catch (err) {
      console.warn('[macro-board] Postgres init failed, falling back to SQLite:', err.message);
      try {
        await backend.close();
      } catch {
        /* ignore */
      }
      backend = createSqliteStore();
      await backend.init();
      return backend;
    }
  }

  backend = createSqliteStore();
  await backend.init();
  return backend;
}

export async function getDb() {
  if (!backend) return initDb();
  return backend;
}

export function dbKind() {
  return backend ? backend.kind : null;
}

// Exported for tests / tooling only.
export { createSqliteStore, createBaseStore, createMirrorStore };