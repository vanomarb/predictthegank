const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { getSmartWindows, sanitizeWindows } = require('../services/gemini');
const { getOrCreateSystemAccountId } = require('../services/system-accounts');
const { getWorkHours, getBreaks } = require('../services/work-hours');

// The confidence labels for the moments inside a range, strongest first. They
// live here rather than in services/gemini.js because the model no longer
// assigns them — the quarter-hour ranking in tiersForHour does.
const TIERS = ['sure', 'likely', 'maybe'];

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
// unix-seconds timestamp in TIMEZONE — used by medianGapMinutes to find gaps
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

  // Minutes-since-local-midnight for every sighting, which is what the exact
  // predicted time is a median over. Kept alongside the raw timestamps because
  // the smart windows are enriched with it too, in GET /stats.
  const minutesOfDay = sightingTimestamps.map((ts) => dateMinutesInTZ(ts).minutes);

  const medianGap = medianGapMinutes(sightingTimestamps);
  const breaks = getBreaks();
  const windows = computePhases(heatmap, minutesOfDay, rows.length, medianGap, breaks);
  return { total: rows.length, heatmap, byPerson, sightingTimestamps, minutesOfDay, medianGap, windows };
}

// The exact clock times inside ONE window.
//
// A window is an hour range, and an hour range is not something anyone can count
// down to. Nor are sightings spread evenly across it: they cluster. So the hour
// is split into quarters, the quarters are ranked by how many sightings landed
// in each, and the top three become sure / likely / maybe — each represented by
// the MEDIAN minute of the sightings in its own quarter.
//
// This is what "the tiers live inside the range" means. Sure/likely/maybe used
// to be three DIFFERENT hours, which made the confidence labels a way of ranking
// unrelated windows against each other; here they rank moments within the one
// window a viewer is actually waiting on, which is the thing they were always
// being read as.
//
// The median, not the mean: one sighting logged at the far end of a quarter
// should not drag the predicted minute with it. An empty quarter falls back to
// its own midpoint and reports a basis of 0, which the page renders differently
// — a fabricated minute has to look different from a measured one.
const QUARTER_MIN = 15;
const QUARTERS = 60 / QUARTER_MIN;

// Break time. HR is not roaming during lunch, so a sighting logged then says
// nothing about the pattern and a prediction landing there is one nobody should
// act on. Every predicted moment is checked against these before it is emitted:
// a quarter-hour that overlaps a break is not a candidate for a tier, an hour
// wholly inside one cannot become a phase, and a wildcard projected into one is
// nudged past it. Configured with BREAK_TIMES — see services/work-hours.js.
const overlapsBreak = (from, to, breaks) =>
  breaks.some((b) => from < b.end && to > b.start);
const inBreak = (minute, breaks) =>
  breaks.some((b) => minute >= b.start && minute < b.end);
// Which break a minute falls in, so the page can name it rather than saying
// "not that one" and leaving the reader to guess why.
function breakNameAt(minute, breaks) {
  const b = breaks.find((x) => minute >= x.start && minute < x.end);
  if (!b) return null;
  return b.start >= 11 * 60 && b.start < 14 * 60 ? 'the lunch break' : 'the break';
}

function medianOf(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

const clockOf = (minutesOfDay) => ({
  hour: Math.floor(minutesOfDay / 60) % 24,
  minute: minutesOfDay % 60,
});

function tiersForHour(minutesOfDay, hourStart, breaks) {
  const base = hourStart * 60;
  const buckets = [];
  for (let q = 0; q < QUARTERS; q += 1) {
    const from = base + q * QUARTER_MIN;
    const to = from + QUARTER_MIN;
    // A quarter that runs into a break is dropped outright rather than having
    // its break minutes filtered out: predicting 15:14 because 15:15-15:30 is
    // unavailable is a prediction shaped by the break, not by the data.
    if (overlapsBreak(from, to, breaks)) continue;
    buckets.push({
      q,
      from,
      to,
      values: minutesOfDay.filter((m) => m >= from && m < to).sort((a, b) => a - b),
    });
  }
  // Busiest quarter first; ties break to the earlier one so the same data always
  // produces the same prediction.
  const ranked = buckets.slice().sort((a, b) => b.values.length - a.values.length || a.q - b.q);

  // Fewer tiers than TIERS when breaks have eaten into the hour. Three of four
  // quarters is the usual worst case; an hour with nothing left never gets here,
  // computePhases drops it first.
  return ranked.slice(0, TIERS.length).map((b, i) => {
    const at = b.values.length ? medianOf(b.values) : Math.round((b.from + b.to - 1) / 2);
    return {
      tier: TIERS[i],
      ...clockOf(at),
      from: b.values.length,
      quarter: `:${String(b.from % 60).padStart(2, '0')}\u2013:${String(b.to % 60).padStart(2, '0')}`,
    };
  });
}

// The median gap between consecutive same-day sightings, in minutes — how long
// HR usually goes between roams. Null until there are two sightings on one day
// to measure a gap from.
function medianGapMinutes(sightingTimestamps) {
  if (sightingTimestamps.length < 2) return null;
  const byDate = new Map();
  sightingTimestamps.forEach((ts) => {
    const { date, minutes } = dateMinutesInTZ(ts);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(minutes);
  });
  const gaps = [];
  byDate.forEach((list) => {
    list.sort((a, b) => a - b);
    for (let i = 1; i < list.length; i += 1) gaps.push(list[i] - list[i - 1]);
  });
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return medianOf(gaps);
}

// The wildcard: one more roam, in the GAP BETWEEN two phases.
//
// It is projected forward from the last predicted moment of a phase by however
// long HR usually goes between sightings, and then held inside the gap that
// follows that phase — from its range ending to the next range starting (or to
// closing time, for the last one). That is what makes it a wildcard rather than
// a fourth prediction: the phases say when HR is expected to be out, and this
// says there is a chance of one more on the way from this phase to the next.
//
// An unclamped projection is not a claim about the gap at all; it can land
// inside the very next phase's range, where it would be competing with that
// phase's own moments, or inside a break, where nobody should be told to expect
// anything. Both are corrected here, and the note says which happened.
function projectWildcard(tiers, medianGap, gapStart, gapEnd, breaks) {
  if (medianGap == null || tiers.length === 0) return null;
  // Adjacent phases (9-10 and 10-11) leave nothing in between, and a gap made
  // entirely of break time leaves nothing usable.
  if (gapEnd - gapStart < 1) return null;

  const gap = Math.round(medianGap);
  const latest = Math.max(...tiers.map((t) => t.hour * 60 + t.minute));
  const projected = Math.round(latest + medianGap);

  let at = Math.min(Math.max(projected, gapStart), gapEnd - 1);
  const clamped = at !== projected;

  // Out of any break it landed in, forward first (a roam pushed later by lunch
  // is the natural reading), and only backwards if the gap runs out.
  const hitBreak = inBreak(at, breaks);
  const pushedPast = hitBreak ? breakNameAt(at, breaks) : null;
  while (inBreak(at, breaks) && at < gapEnd - 1) at += 1;
  if (inBreak(at, breaks)) {
    while (inBreak(at, breaks) && at > gapStart) at -= 1;
    if (inBreak(at, breaks)) return null; // the whole gap is break time
  }

  let note = `projected from the usual ${gap}-minute gap between sightings`;
  if (pushedPast) note += `, nudged past ${pushedPast}`;
  else if (clamped && at === gapStart) note += ', the earliest a roam could slot in here';
  else if (clamped) note += ', the last chance before the next window';
  else if (at >= (OFFICE_HOURS.end - 1) * 60) note += ', right at the end of the day';

  return { tier: 'wildcard', ...clockOf(at), from: null, note };
}

// Builds one window's worth of predictions: the range and the data-backed
// moments inside it. The wildcard is added afterwards by withWildcards, which
// needs to see the NEXT phase to know how big the gap after this one is.
function buildPhase({ hourStart, hourEnd, count, total, minutesOfDay, breaks, extra }) {
  return {
    hourStart,
    hourEnd,
    count,
    pct: total ? Math.round((count / total) * 100) : 0,
    // Clock order: the rows are a run through the window, so the tier a row
    // carries is a property of the moment, not its place in a list.
    tiers: tiersForHour(minutesOfDay, hourStart, breaks)
      .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)),
    ...(extra || {}),
  };
}

// Adds each phase's wildcard, aimed at the gap between it and the phase after
// it. Takes the whole run in clock order because "the gap after this phase" is
// not something a single phase knows.
function withWildcards(phases, medianGap, breaks) {
  return phases.map((phase, i) => {
    const next = phases[i + 1];
    const gapStart = phase.hourEnd * 60;
    const gapEnd = next ? next.hourStart * 60 : OFFICE_HOURS.end * 60;
    const wildcard = projectWildcard(phase.tiers, medianGap, gapStart, gapEnd, breaks);
    if (!wildcard) return phase;
    return { ...phase, tiers: [...phase.tiers, wildcard] };
  });
}

// Statistical fallback: recurring time-of-day pattern, independent of which
// weekday it fell on (a handful of sightings per weekday isn't enough signal —
// pooling by hour-of-day across every day matches what the underlying pattern
// actually looks like). The hours that stand out become the day's PHASES — when
// HR is expected to be out and about — and each phase carries its own
// sure/likely/maybe/wildcard moments (see tiersForHour).
//
// HOW MANY PHASES. The data decides, not a fixed number. A day whose sightings
// all land in one hour gets one phase; a day with four genuinely distinct
// clusters gets four. Padding a thin day out to a fixed three means inventing
// two ranges nothing supports and rendering them as confidently as the real one,
// and truncating a busy day at three hides a pattern that is really there.
//
// An hour qualifies when it clears BOTH tests, which catch different failures:
//
//   - a minimum share of the day's sightings, which drops the long tail of
//     hours holding one stray log; and
//   - a minimum fraction of the BUSIEST hour's count, which is what handles a
//     strong peak with a thin tail. 40 sightings at 9am and a scattering of
//     ones and twos across the afternoon is ONE pattern, not four; the share
//     test alone would let a 2-sighting hour through on a quiet day.
//
// The busiest hour is always kept whatever it scores, so a day with any data at
// all still says something.
//
// A genuinely flat day — every hour equally busy — passes both tests on every
// hour and comes back full, up to the ceiling. That is deliberate: "they are out
// all day" is what that data says, and picking three of seven identical hours to
// present as special would be the dishonest answer, not the tidy one.
const PHASE_MIN_SHARE = 0.1;      // >= 10% of all sightings
const PHASE_MIN_OF_PEAK = 0.4;    // >= 40% of the busiest hour
//
// The ceiling is a layout limit, not a statistical one: past about half a dozen
// the list stops reading as a schedule and starts reading as a log. Collapsing
// the phases that are not in play (see the card in public.js) is what makes a
// ceiling this high safe.
//
// FUTURE: if this ever becomes a product with accounts rather than one team's
// toy, this ceiling is the natural place to meter — free tier capped at the old
// three phases, paid tiers up to the full ceiling. It is already a parameter for
// exactly that reason: computePhases takes the limit rather than reading the
// constant, so a per-plan value can be threaded through from the caller without
// touching the statistics. Nothing here is gated today.
const PHASE_CEILING = 6;

// Which hours earn a phase, in clock order. Split out from computePhases so the
// selection rule can be read — and tested — on its own.
function selectPhaseHours(hourTotals, total, breaks, limit) {
  const ranked = hourTotals
    .map((count, hour) => ({ hour, count }))
    .filter((w) => w.count > 0)
    // An hour wholly inside a break is not a phase, however many sightings fell
    // in it. The noon hour is lunch; that HR walks past the desks on the way out
    // is not a pattern to schedule around.
    .filter((w) => !breaks.some((b) => b.start <= w.hour * 60 && b.end >= (w.hour + 1) * 60))
    .sort((a, b) => b.count - a.count || a.hour - b.hour);

  if (ranked.length === 0) return [];
  const peak = ranked[0].count;

  return ranked
    .filter((w, i) => i === 0 // the busiest hour is always a phase
      || (w.count / total >= PHASE_MIN_SHARE && w.count >= peak * PHASE_MIN_OF_PEAK))
    .slice(0, limit)
    .sort((a, b) => a.hour - b.hour);
}

// Phases are returned in clock order, because they are a schedule. Which one is
// "next" is a question about the time of day, not about which hour has the most
// sightings; the count rides along on each phase so the page can still say how
// much is behind it.
function computePhases(heatmap, minutesOfDay, total, medianGap, breaks, limit = PHASE_CEILING) {
  const hourTotals = Array(24).fill(0);
  heatmap.forEach((dayRow) => dayRow.forEach((count, hour) => { hourTotals[hour] += count; }));

  const phases = selectPhaseHours(hourTotals, total, breaks, limit)
    .map((w) => buildPhase({
      hourStart: w.hour,
      hourEnd: w.hour + 1,
      count: w.count,
      total,
      minutesOfDay,
      breaks,
    }))
    .filter((p) => p.tiers.length > 0);

  return withWildcards(phases, medianGap, breaks);
}

async function readStoredSmartWindows() {
  const row = await db.one('SELECT windows FROM smart_predictions WHERE id = true');
  return row ? row.windows : null;
}

// Recomputes the Gemini analysis from current data and persists it, so GET
// /stats can serve it to everyone with zero extra API calls.
//
// Called once a day by the cron job (see routes/cron.js), never from a request
// path. It used to fire after every sighting logged from /admin, which meant one
// Gemini call per log to re-answer a question whose answer barely moves — and a
// prediction that could change under a reader mid-afternoon.
//
// Never throws, and never clobbers a good stored prediction with a bad one: a
// disabled or failed Gemini call leaves the previous windows in place. Returns a
// small report rather than nothing, because the only person who will ever see
// this run is reading a cron log.
async function recomputeSmartPrediction() {
  try {
    const { heatmap, sightingTimestamps, total } = await buildHeatmapAndPrediction();
    if (total === 0) return { ok: true, skipped: 'no sightings logged yet' };
    // The model is given the office's rules — work hours, work days, breaks —
    // and how many phases the page has room for, so its ranges come back fitting
    // the day they describe. It is also held to them on the way back; see
    // sanitizeWindows in services/gemini.js.
    const smart = await getSmartWindows({
      sightingTimestamps,
      heatmap,
      total,
      workHours: getWorkHours(),
      breaks: getBreaks(),
      timeZone: TIMEZONE,
      maxWindows: PHASE_CEILING,
    });
    // null means the feature is off (no API key) or the call failed; either way
    // the previously stored windows stay as they are.
    if (!smart) return { ok: true, skipped: 'gemini returned nothing', total };
    await db.query(
      `INSERT INTO smart_predictions (id, windows, sightings_total, computed_at)
       VALUES (true, $1, $2, EXTRACT(EPOCH FROM now())::bigint)
       ON CONFLICT (id) DO UPDATE SET
         windows = EXCLUDED.windows,
         sightings_total = EXCLUDED.sightings_total,
         computed_at = EXCLUDED.computed_at`,
      [JSON.stringify(smart.windows), total]
    );
    return { ok: true, windows: smart.windows.length, total };
  } catch (e) {
    console.error('[gemini] failed to persist smart windows:', e.message);
    return { ok: false, error: e.message };
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

// Logging a sighting deliberately does NOT recompute the Gemini prediction any
// more; that runs once a day from routes/cron.js. See the note above
// recomputeSmartPrediction.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    res.json(await logSightingForAccount(req.user.id));
  } catch (e) {
    next(e);
  }
});

// Public, unauthenticated: a quick "I just saw them" button on the public page.
// Attributed to the shared "Anonymous" system account (auto-created if this is
// the very first anonymous log on a fresh deploy) — never login-capable, see
// services/system-accounts.js. Rate-limited in server.js. Like the admin log
// route, it never triggers a Gemini recompute: nothing on a request path does.
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
// Gemini itself — smartWindows is whatever the daily cron last persisted (see
// routes/cron.js).
router.get('/stats', optionalAuth, async (req, res, next) => {
  try {
    const { total, heatmap, byPerson, minutesOfDay, medianGap, windows } = await buildHeatmapAndPrediction();
    const stored = await readStoredSmartWindows();

    // Gemini is asked for an hour range and nothing finer — a model guessing at
    // a minute would be inventing precision. The moments inside the range are
    // derived here from the same sightings the statistical phases use, so both
    // kinds of window are built the same way and only the RANGE differs.
    //
    // Sanitized again on the way out, not only on the way in. What is stored was
    // written by a previous deploy under whatever rules were in force then;
    // change WORK_HOURS_END or BREAK_TIMES and yesterday's stored ranges can
    // suddenly straddle a break or sit after closing. Re-checking here costs
    // nothing and means a config change takes effect immediately rather than at
    // the next cron run.
    const breaks = getBreaks();
    const workHours = getWorkHours();
    const smartWindows = Array.isArray(stored)
      ? withWildcards(
        sanitizeWindows(stored, { workHours, breaks, max: PHASE_CEILING })
          .map((w) => buildPhase({
            hourStart: w.predictedHourStart,
            hourEnd: w.predictedHourEnd,
            count: minutesOfDay.filter((m) => m >= w.predictedHourStart * 60 && m < w.predictedHourEnd * 60).length,
            total,
            minutesOfDay,
            breaks,
            extra: { confidence: w.confidence, rationale: w.rationale },
          }))
          .filter((p) => p.tiers.length > 0),
        medianGap,
        breaks,
      )
      : stored;

    const payload = { total, heatmap, windows, smartWindows };
    if (req.user) payload.byPerson = byPerson;
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

// The daily cron job needs the recompute, everything else needs the router. An
// object rather than the router with properties hung off it, so neither caller
// has to know that an express Router happens to be a function.
module.exports = { router, recomputeSmartPrediction };
