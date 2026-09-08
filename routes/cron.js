/**
 * Scheduled work, triggered from outside: on Vercel by the `crons` entry in
 * vercel.json, anywhere else by a plain HTTP GET from crontab or a scheduler.
 *
 * There is one job. It recomputes the Gemini-refined prediction once a day, at
 * the end of the working day, and stores it for GET /sightings/stats to serve.
 *
 * WHY A CRON RATHER THAN A TRIGGER. The recompute used to fire after every
 * sighting logged from /admin. That is one Gemini call per log, which on a busy
 * day is dozens of calls to answer a question whose answer barely moves — the
 * model is looking for a recurring daily pattern across every sighting ever
 * logged, and one more data point does not change it. Worse, it made the
 * prediction shift under a viewer mid-afternoon, so the page could contradict
 * what it said five minutes earlier for no visible reason.
 *
 * Once a day, after the last window has closed, means: exactly one call, made
 * when the day's data is complete, and a prediction that holds still while
 * people are actually reading it.
 *
 * AUTHORIZATION. Vercel sends `Authorization: Bearer $CRON_SECRET` when
 * CRON_SECRET is set as an environment variable. This route requires it: the
 * endpoint spends money at a third-party API, so an unauthenticated version of
 * it is a way for anyone with the URL to run up a bill. With CRON_SECRET unset
 * the route refuses outright rather than falling open.
 */

const express = require('express');
const { recomputeSmartPrediction, snapshotTodayPhases } = require('./sightings');
const { getWorkHours, getTimeZone } = require('../services/work-hours');

const router = express.Router();

// Day of week in the office timezone, 0 = Sunday — the same indexing as
// WORK_DAYS and the heatmap.
function currentDayInTZ(timeZone) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date());
  const idx = DAYS.indexOf(short);
  return idx === -1 ? new Date().getUTCDay() : idx;
}

// Timing-safe enough for this: the comparison is on a value the caller already
// has to guess in full, and the endpoint is not a login.
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

router.get('/refresh-prediction', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    console.warn('[cron] refresh-prediction called but CRON_SECRET is not set — refusing.');
    return res.status(503).json({ ok: false, reason: 'CRON_SECRET is not configured' });
  }
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, reason: 'unauthorized' });

  // Vercel's scheduler runs in UTC and Hobby projects get one run a day, so the
  // schedule in vercel.json is daily rather than Mon-Fri. The weekend skip
  // belongs here anyway: the work days are configuration, and configuration
  // that lives in two places drifts.
  const timeZone = getTimeZone();
  const workHours = getWorkHours();
  const day = currentDayInTZ(timeZone);
  if (!workHours.days.includes(day)) {
    console.log(`[cron] skipping refresh-prediction — day ${day} is not a work day.`);
    return res.json({ ok: true, skipped: 'not a work day', day });
  }

  // Freeze today's own phases BEFORE recomputing the AI answer for tomorrow —
  // otherwise this would snapshot tomorrow's prediction as if it were today's.
  // See the note on snapshotTodayPhases in routes/sightings.js.
  const snapshot = await snapshotTodayPhases();
  console.log('[cron] snapshot-phases:', JSON.stringify(snapshot));

  const result = await recomputeSmartPrediction();
  console.log('[cron] refresh-prediction:', JSON.stringify(result));
  // A failed refresh (or a failed snapshot) answers with a failing status, so
  // it shows as a failure in Vercel's cron log instead of a green tick over a
  // job that did nothing.
  const ok = result.ok && snapshot.ok;
  return res.status(ok ? 200 : 500).json({ ok, snapshot, prediction: result });
});

module.exports = router;
