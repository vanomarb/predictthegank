const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { getSmartWindows, TIERS } = require('../services/gemini');
const { getOrCreateSystemAccountId } = require('../services/system-accounts');

const router = express.Router();
const DEDUP_WINDOW_SECONDS = 2 * 60;
const TIMEZONE = process.env.TIMEZONE || 'UTC';
const SIGHTING_LOCK_KEY = 8817231; // arbitrary fixed advisory-lock key for the sightings resource
const OFFICE_HOURS = { start: 9, end: 18 }; // 9:00am-6:00pm

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const dayHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'short',
  hour: 'numeric',
  hour12: false,
});
const dateMinuteFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: 'numeric', hour12: false,
});

// Computes {day, hour} for a unix-seconds timestamp in TIMEZONE, instead of the
// server process's local timezone (which would silently shift on Vercel, where
// functions run in UTC regardless of where the team actually is).
function dayHourInTZ(ts) {
  const parts = dayHourFormatter.formatToParts(new Date(ts * 1000));
  const weekday = parts.find((p) => p.type === 'weekday').value;
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  return { day: WEEKDAY_INDEX[weekday], hour };
}

// Computes {date: 'YYYY-MM-DD', minutes: minutes-since-local-midnight} for a
// unix-seconds timestamp in TIMEZONE — used by computeWildcard to find gaps
// between same-day sightings down to the minute, not just the hour.
function dateMinutesInTZ(ts) {
  const parts = dateMinuteFormatter.formatToParts(new Date(ts * 1000));
  const get = (type) => parts.find((p) => p.type === type).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  return { date, minutes: hour * 60 + minute };
}

// Shared by GET /stats and the post-log Gemini trigger below.
async function buildHeatmapAndPrediction() {
  const rows = await db.many(`
    SELECT s.ts, string_agg(a.name, ', ') AS logged_by
    FROM sightings s
    JOIN sighting_logs sl ON sl.sighting_id = s.id
    JOIN accounts a ON a.id = sl.account_id
    GROUP BY s.id
  `);

  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const byPerson = {};
  const sightingTimestamps = [];
  rows.forEach((r) => {
    const { day, hour } = dayHourInTZ(r.ts);
    heatmap[day][hour]++;
    sightingTimestamps.push(r.ts);
    r.logged_by.split(', ').forEach((n) => { byPerson[n] = (byPerson[n] || 0) + 1; });
  });
  sightingTimestamps.sort((a, b) => b - a);

  const windows = computeWindows(heatmap, rows.length);
  const wildcard = computeWildcard(sightingTimestamps, windows);
  return { total: rows.length, heatmap, byPerson, sightingTimestamps, windows, wildcard };
}

// Statistical fallback: recurring time-of-day pattern, independent of which
// weekday it fell on (a handful of sightings per weekday isn't enough signal —
// pooling by hour-of-day across every day matches what the underlying pattern
// actually looks like). Top 3 non-zero hours by count become sure/likely/maybe;
// ties break to the earlier hour.
function computeWindows(heatmap, total) {
  const hourTotals = Array(24).fill(0);
  heatmap.forEach((dayRow) => dayRow.forEach((count, hour) => { hourTotals[hour] += count; }));

  return hourTotals
    .map((count, hour) => ({ hour, count }))
    .filter((w) => w.count > 0)
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
    .slice(0, TIERS.length)
    .map((w, i) => ({
      tier: TIERS[i],
      hourStart: w.hour,
      hourEnd: w.hour + 1,
      count: w.count,
      pct: total ? Math.round((w.count / total) * 100) : 0,
    }));
}

// A 4th, always-statistical possibility, expressed as one specific projected
// clock time (not a range): "based on how far apart roams usually are, is
// there a small chance of one later today?" Computed from the actual gap
// pattern between consecutive same-day sightings (median gap, minute
// precision) — not just which hour bucket has leftover counts. Anchored from
// today's most recent sighting if there's been one today, otherwise from the
// end of the latest sure/likely/maybe window; never projects into the past
// (floors at "now"), and returns null if the projection lands at/after
// closing time or there isn't enough gap data yet to compute a median. Not
// eligible to ever become the featured/countdown tier (see classifyWindows
// in viz.js) — informational, a "small possibility," not a firm prediction.
function computeWildcard(sightingTimestamps, windows) {
  if (windows.length === 0 || sightingTimestamps.length < 2) return null;

  const byDate = new Map();
  sightingTimestamps.forEach((ts) => {
    const { date, minutes } = dateMinutesInTZ(ts);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(minutes);
  });

  const gaps = [];
  byDate.forEach((minutesList) => {
    minutesList.sort((a, b) => a - b);
    for (let i = 1; i < minutesList.length; i++) gaps.push(minutesList[i] - minutesList[i - 1]);
  });
  if (gaps.length === 0) return null;

  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianGap = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];

  const nowParts = dateMinutesInTZ(Math.floor(Date.now() / 1000));
  const todayMinutes = (byDate.get(nowParts.date) || []).sort((a, b) => a - b);

  const anchorMinutes = todayMinutes.length > 0
    ? todayMinutes[todayMinutes.length - 1]
    : Math.max(...windows.map((w) => w.hourEnd)) * 60;

  const projected = Math.max(anchorMinutes, nowParts.minutes) + medianGap;
  if (projected < OFFICE_HOURS.start * 60 || projected >= OFFICE_HOURS.end * 60) return null;

  return {
    tier: 'wildcard',
    hour: Math.floor(projected / 60),
    minute: Math.round(projected % 60),
  };
}

async function readStoredSmartWindows() {
  const row = await db.one('SELECT windows FROM smart_predictions WHERE id = true');
  return row ? row.windows : null;
}

// Fired (not awaited) after a sighting is logged from /admin — never from the
// public page's poll loop or the anonymous public endpoint, both of which are
// far more frequent/abuse-prone. Recomputes the Gemini analysis from current
// data and persists it so GET /stats can serve it to everyone with zero extra
// API calls. A failed/disabled Gemini call leaves the previously stored
// windows as-is rather than clobbering them with null.
async function recomputeSmartPrediction() {
  try {
    const { heatmap, sightingTimestamps, total } = await buildHeatmapAndPrediction();
    const smart = await getSmartWindows({ sightingTimestamps, heatmap, total });
    if (!smart) return;
    await db.query(
      `INSERT INTO smart_predictions (id, windows, sightings_total, computed_at)
       VALUES (true, $1, $2, EXTRACT(EPOCH FROM now())::bigint)
       ON CONFLICT (id) DO UPDATE SET
         windows = EXCLUDED.windows,
         sightings_total = EXCLUDED.sightings_total,
         computed_at = EXCLUDED.computed_at`,
      [JSON.stringify(smart.windows), total]
    );
  } catch (e) {
    console.error('[gemini] failed to persist smart windows:', e.message);
  }
}

// Log a sighting now, for the given account. Merges into an existing sighting
// within the dedup window instead of creating a duplicate. Runs inside a
// transaction guarded by a session advisory lock so concurrent requests can't
// both miss the dedup window and each insert a new sighting row (a race that
// only "worked" before because better-sqlite3's synchronous queries
// accidentally serialized every request). Shared by the authenticated and
// anonymous logging routes below.
async function logSightingForAccount(accountId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SIGHTING_LOCK_KEY]);

    const now = Math.floor(Date.now() / 1000);
    const { rows: [recent] } = await client.query(
      'SELECT id FROM sightings WHERE ABS(ts - $1) < $2 ORDER BY ABS(ts - $1) ASC LIMIT 1',
      [now, DEDUP_WINDOW_SECONDS]
    );

    let sightingId, merged;
    if (recent) {
      sightingId = recent.id;
      merged = true;
    } else {
      const { rows: [inserted] } = await client.query(
        'INSERT INTO sightings (ts) VALUES ($1) RETURNING id',
        [now]
      );
      sightingId = inserted.id;
      merged = false;
    }

    const { rows: logRows } = await client.query(
      `INSERT INTO sighting_logs (sighting_id, account_id) VALUES ($1, $2)
       ON CONFLICT (sighting_id, account_id) DO NOTHING RETURNING *`,
      [sightingId, accountId]
    );
    const alreadyLogged = logRows.length === 0;

    await client.query('COMMIT');
    return { merged, alreadyLogged, sightingId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const result = await logSightingForAccount(req.user.id);
    res.json(result);
    // Fire-and-forget: don't make the person logging the sighting wait on Gemini.
    if (!result.alreadyLogged) recomputeSmartPrediction();
  } catch (e) {
    next(e);
  }
});

// Public, unauthenticated: a quick "I just saw them" button on the public page.
// Attributed to the shared "Anonymous" system account (auto-created if this is
// the very first anonymous log on a fresh deploy) — never login-capable, see
// services/system-accounts.js. Rate-limited in server.js. Deliberately does NOT
// trigger a Gemini recompute — that stays admin-log-triggered only, since this
// route is public and higher risk of being hammered.
router.post('/anonymous', async (req, res, next) => {
  try {
    const accountId = await getOrCreateSystemAccountId(db, 'Anonymous');
    const result = await logSightingForAccount(accountId);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Undo the current user's most recent contribution.
router.delete('/mine/latest', requireAuth, async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SIGHTING_LOCK_KEY]);

    const { rows: [row] } = await client.query(
      `SELECT sl.sighting_id,
              (SELECT COUNT(*) FROM sighting_logs WHERE sighting_id = sl.sighting_id) AS logger_count
       FROM sighting_logs sl
       WHERE sl.account_id = $1
       ORDER BY sl.logged_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nothing to undo.' });
    }

    await client.query(
      'DELETE FROM sighting_logs WHERE sighting_id = $1 AND account_id = $2',
      [row.sighting_id, req.user.id]
    );

    if (row.logger_count <= 1) {
      await client.query('DELETE FROM sightings WHERE id = $1', [row.sighting_id]);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    next(e);
  } finally {
    client.release();
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.many(`
      SELECT s.id, s.ts, string_agg(a.name, ', ') AS logged_by
      FROM sightings s
      JOIN sighting_logs sl ON sl.sighting_id = s.id
      JOIN accounts a ON a.id = sl.account_id
      GROUP BY s.id
      ORDER BY s.ts DESC
      LIMIT 500
    `);
    res.json({ sightings: rows });
  } catch (e) {
    next(e);
  }
});

// Unauthenticated-friendly: the public landing page polls this every 5s. Per-person
// attribution (byPerson) is only included for logged-in requests. Never calls
// Gemini itself — smartWindows is whatever recomputeSmartPrediction last
// persisted from an actual /admin log action.
router.get('/stats', optionalAuth, async (req, res, next) => {
  try {
    const { total, heatmap, byPerson, windows, wildcard } = await buildHeatmapAndPrediction();
    const smartWindows = await readStoredSmartWindows();

    const payload = { total, heatmap, windows, smartWindows, wildcard };
    if (req.user) payload.byPerson = byPerson;
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
