/**
 * Every runtime setting, in one place: what it is called, how it is parsed, what
 * counts as a valid value, and where its value comes from when nobody has set it.
 *
 *   app_settings row  ->  environment variable  ->  built-in default
 *
 * WHY A SPEC TABLE. These are read from four modules and written from one admin
 * route. Spreading the precedence and the validation across all five is how a
 * dashboard ends up accepting a working day that ends before it starts, or
 * showing an environment variable it is quietly ignoring. One table, one answer.
 *
 * SECRETS ARE NOT HERE, AND WILL NOT BE. GEMINI_API_KEY, CRON_SECRET, JWT_SECRET
 * and SUPABASE_DB_URL stay in the environment: a value editable from a browser
 * session is a value a stolen browser session can edit. The dashboard reports
 * them as set/not-set and never reads them.
 *
 * SYNCHRONOUS READS. getWorkHours() is called on the hot path of every request
 * and inside tight loops in the prediction engine, so it cannot become async.
 * The rows are held in a snapshot refreshed in the background; a write updates it
 * immediately, so an admin never sees their own change lag, and another
 * serverless instance picks it up within CACHE_MS. These values change a few
 * times a year, so that window costs nothing.
 *
 * DEGRADES RATHER THAN BREAKS. If app_settings does not exist — a deploy that has
 * not run migrations/0005 — every read falls through to the environment and the
 * app behaves exactly as it did before.
 */

// The rule for a model name lives with the URL it protects; see gemini.js.
const { isValidModel } = require('./gemini');

const CACHE_MS = 60 * 1000;
const UNDEFINED_TABLE = '42P01'; // Postgres: undefined_table

const DEFAULT_MODEL = 'gemini-3.6-flash';
const DEFAULT_BREAKS = '12:00-13:00,15:15-15:30';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isInt = (n) => Number.isInteger(n);

/* -------------------------------- parsing ------------------------------- */

// "1-5" or "1,2,3,4,5" or "0,6" — 0 is Sunday, matching JS getDay() and the
// heatmap's own day indexing.
function parseDays(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const text = String(raw);
  const range = /^\s*(\d)\s*-\s*(\d)\s*$/.exec(text);
  let days;
  if (range) {
    const [, from, to] = range.map(Number);
    days = [];
    for (let d = from; d <= to; d += 1) days.push(d);
  } else {
    days = text.split(',').map((p) => Number.parseInt(p.trim(), 10));
  }
  days = [...new Set(days.filter((d) => isInt(d) && d >= 0 && d <= 6))].sort();
  return days.length ? days : null;
}

// "12:00-13:00,15:15-15:30" -> [{ start: 720, end: 780 }, ...], minutes since
// midnight, end exclusive. An unparseable entry is DROPPED rather than
// defaulted: a typo that silently invents a break in the middle of the afternoon
// is worse than one that goes missing and gets noticed.
function parseBreaks(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return []; // explicitly "no breaks", which is a real answer
  const minutes = (hh, mm) => hh * 60 + mm;
  const parsed = text.split(',')
    .map((part) => /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part))
    .filter(Boolean)
    .map((m) => ({ start: minutes(+m[1], +m[2]), end: minutes(+m[3], +m[4]) }))
    .filter((b) => b.end > b.start && b.start >= 0 && b.end <= 24 * 60)
    .sort((a, b) => a.start - b.start);
  return parsed.length ? parsed : null;
}

const pad = (n) => String(n).padStart(2, '0');
const breaksToText = (breaks) => (breaks || [])
  .map((b) => `${pad(Math.floor(b.start / 60))}:${pad(b.start % 60)}`
    + `-${pad(Math.floor(b.end / 60))}:${pad(b.end % 60)}`)
  .join(',');

// A timezone the runtime actually knows. An unknown one makes every Intl call
// throw, and on this app that is the heatmap, the countdown and the work-hours
// gate failing at once — so it is checked before it can be stored.
function isKnownTimeZone(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z0-9+_/-]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------- the settings ---------------------------- */

/**
 * key      -> the app_settings row, and the field name in the API
 * env      -> the environment variable it falls back to
 * fallback -> the built-in default, when neither is set
 * parse    -> stored/env text -> value, or null if unusable
 * check    -> value -> true if it may be stored
 * text     -> value -> the string to store
 */
const SPEC = {
  aiModel: {
    key: 'ai_model',
    env: 'GEMINI_MODEL',
    fallback: DEFAULT_MODEL,
    parse: (raw) => (isValidModel(raw) ? String(raw) : null),
    check: isValidModel,
    text: String,
  },
  timeZone: {
    key: 'timezone',
    env: 'TIMEZONE',
    fallback: 'UTC',
    parse: (raw) => (isKnownTimeZone(raw) ? String(raw) : null),
    check: isKnownTimeZone,
    text: String,
  },
  workStart: {
    key: 'work_start',
    env: 'WORK_HOURS_START',
    fallback: 9,
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return isInt(n) && n >= 0 && n <= 23 ? n : null;
    },
    check: (v) => isInt(v) && v >= 0 && v <= 23,
    text: String,
  },
  workEnd: {
    key: 'work_end',
    env: 'WORK_HOURS_END',
    fallback: 18,
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return isInt(n) && n >= 1 && n <= 24 ? n : null;
    },
    check: (v) => isInt(v) && v >= 1 && v <= 24,
    text: String,
  },
  workDays: {
    key: 'work_days',
    env: 'WORK_DAYS',
    fallback: [1, 2, 3, 4, 5],
    parse: parseDays,
    check: (v) => Array.isArray(v) && v.length > 0
      && v.every((d) => isInt(d) && d >= 0 && d <= 6),
    text: (v) => v.join(','),
  },
  breaks: {
    key: 'breaks',
    env: 'BREAK_TIMES',
    fallback: parseBreaks(DEFAULT_BREAKS),
    parse: parseBreaks,
    check: (v) => Array.isArray(v)
      && v.every((b) => isInt(b.start) && isInt(b.end) && b.end > b.start
        && b.start >= 0 && b.end <= 24 * 60),
    text: breaksToText,
  },
  phaseCeiling: {
    key: 'phase_ceiling',
    env: 'PHASE_CEILING',
    fallback: 6,
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return isInt(n) && n >= 1 && n <= 12 ? n : null;
    },
    check: (v) => isInt(v) && v >= 1 && v <= 12,
    text: String,
  },
  // How many predicted moments (sure/likely/maybe/long-shot) a phase card may
  // show. Capped at 4, not 12 like phaseCeiling: a phase is one hour split into
  // four 15-minute quarters (see quarterBuckets in routes/sightings.js), so a
  // fifth tier would have no quarter left to occupy — the statistical engine
  // could never fill it, and asking Gemini for one just invites it to invent a
  // moment outside that structure.
  momentCeiling: {
    key: 'moment_ceiling',
    env: 'MOMENT_CEILING',
    fallback: 3,
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return isInt(n) && n >= 1 && n <= 4 ? n : null;
    },
    check: (v) => isInt(v) && v >= 1 && v <= 4,
    text: String,
  },
};

const FIELDS = Object.keys(SPEC);
const KEY_TO_FIELD = new Map(FIELDS.map((f) => [SPEC[f].key, f]));

/* ------------------------------- the snapshot --------------------------- */

const snapshot = new Map(); // app_settings.key -> raw text
let snapshotAt = 0;
let loaded = false;
let inFlight = null;

// Lazy, so merely loading this module does not require a database connection —
// the same mistake that briefly made the Gemini client unloadable without one.
const db = () => require('../db');

async function primeSettings() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const rows = await db().many('SELECT key, value FROM app_settings');
      snapshot.clear();
      for (const row of rows) snapshot.set(row.key, row.value);
    } catch (e) {
      if (e.code !== UNDEFINED_TABLE) throw e;
      snapshot.clear(); // no table: nothing is overridden
    } finally {
      snapshotAt = Date.now();
      loaded = true;
      inFlight = null;
    }
    return snapshot;
  })();
  return inFlight;
}

// Never blocks. A stale snapshot triggers a background refresh and answers from
// what it has, because the alternative is an await on the hot path of every
// request to read a value that changes twice a year.
function rawSync(key) {
  if (!loaded || Date.now() - snapshotAt > CACHE_MS) {
    primeSettings().catch((e) => console.error('[settings] refresh failed:', e.message));
  }
  return snapshot.has(key) ? snapshot.get(key) : null;
}

/* ------------------------------- resolution ----------------------------- */

// The value in force, and where it came from. One function, so every caller and
// the dashboard agree on the precedence.
function resolve(field) {
  const spec = SPEC[field];
  const stored = spec.parse(rawSync(spec.key));
  if (stored !== null && spec.check(stored)) return { value: stored, source: 'admin' };
  const fromEnv = spec.parse(process.env[spec.env]);
  if (fromEnv !== null && spec.check(fromEnv)) return { value: fromEnv, source: 'environment' };
  return { value: spec.fallback, source: 'default' };
}

const get = (field) => resolve(field).value;

// The whole office, resolved together, so one request cannot see two different
// configurations.
function office() {
  const start = get('workStart');
  let end = get('workEnd');
  // A day ending at or before it starts would disable the log button forever,
  // which is a very confusing way to learn about a typo. The stored value is not
  // rewritten — it is simply not honoured.
  if (end <= start) end = SPEC.workEnd.fallback > start ? SPEC.workEnd.fallback : 24;
  return {
    timeZone: get('timeZone'),
    workHours: { start, end, days: get('workDays') },
    breaks: get('breaks'),
    phaseCeiling: get('phaseCeiling'),
    momentCeiling: get('momentCeiling'),
    aiModel: get('aiModel'),
  };
}

/* -------------------------------- writing ------------------------------- */

async function setField(field, rawValue, accountId) {
  const spec = SPEC[field];
  if (!spec) throw Object.assign(new Error(`unknown setting: ${field}`), { status: 400 });
  const parsed = spec.parse(typeof rawValue === 'string' ? rawValue : spec.text(rawValue));
  if (parsed === null || !spec.check(parsed)) {
    throw Object.assign(new Error(`invalid value for ${field}`), { status: 400 });
  }
  const text = spec.text(parsed);
  await db().query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, EXTRACT(EPOCH FROM now())::bigint, $3)
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at,
       updated_by = EXCLUDED.updated_by`,
    [spec.key, text, accountId || null]
  );
  // Immediately, so the admin who just saved sees their own change.
  snapshot.set(spec.key, text);
  return parsed;
}

// Drops the override, handing the field back to the environment.
async function clearField(field) {
  const spec = SPEC[field];
  if (!spec) throw Object.assign(new Error(`unknown setting: ${field}`), { status: 400 });
  try {
    await db().query('DELETE FROM app_settings WHERE key = $1', [spec.key]);
  } catch (e) {
    if (e.code !== UNDEFINED_TABLE) throw e;
  }
  snapshot.delete(spec.key);
}

// Who last touched each stored setting, for the dashboard's "changed by" line.
async function settingsMeta() {
  try {
    const rows = await db().many(
      `SELECT s.key, s.updated_at, a.name AS updated_by
         FROM app_settings s
         LEFT JOIN accounts a ON a.id = s.updated_by`
    );
    const out = {};
    for (const row of rows) {
      const field = KEY_TO_FIELD.get(row.key);
      if (field) out[field] = { changedAt: row.updated_at, changedBy: row.updated_by };
    }
    return out;
  } catch (e) {
    if (e.code !== UNDEFINED_TABLE) throw e;
    return {};
  }
}

module.exports = {
  SPEC, FIELDS, DAY_NAMES, DEFAULT_MODEL, DEFAULT_BREAKS,
  primeSettings, resolve, get, office, setField, clearField, settingsMeta,
  parseDays, parseBreaks, breaksToText, isKnownTimeZone,
  _snapshot: snapshot,
  _reset: () => { snapshot.clear(); snapshotAt = 0; loaded = false; },
};
