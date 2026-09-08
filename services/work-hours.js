/**
 * The office: its clock, its working day, its breaks, and how many phases the
 * page has room for.
 *
 * It lives server-side and ships to the browser through /api/config for the same
 * reason the heatmap's timezone does: the team's working day is a property of the
 * office, not of whichever timezone a given viewer's laptop is set to. A viewer
 * in another country still sees the button enabled and disabled on the office's
 * clock.
 *
 * Hours are inclusive of the start and exclusive of the end, so 9-18 means the
 * button goes live at 09:00 and dies at 18:00 sharp.
 *
 * BREAK_TIMES carves the breaks back out of that day. HR is not roaming during
 * lunch, so a sighting logged then says nothing about the pattern and a
 * prediction landing there is one nobody should act on — predictions skip those
 * minutes entirely. Logging is deliberately NOT blocked during a break: if HR
 * really does walk past at 12:30, that is worth recording even though it is not
 * something to forecast from.
 *
 * THIS IS NOW A FACADE. All of it used to be read straight from the environment
 * here, which meant changing the working day took an env edit and a redeploy.
 * The values are configurable from the admin dashboard, so the parsing,
 * precedence and validation moved to services/settings.js — one table for every
 * knob rather than each module reading the environment its own way. These
 * getters stay, unchanged in signature and still synchronous, because they are
 * called on the hot path of every request and from four other modules.
 */

const settings = require('./settings');

const DEFAULTS = {
  start: settings.SPEC.workStart.fallback,
  end: settings.SPEC.workEnd.fallback,
  days: settings.SPEC.workDays.fallback,
};

const getWorkHours = () => settings.office().workHours;
const getBreaks = () => settings.office().breaks;

// The office clock. Every timestamp the app buckets, formats or predicts against
// is read in this zone, never the server's own — Vercel functions run in UTC
// wherever the team actually is.
const getTimeZone = () => settings.get('timeZone');

// How many roam phases the page will show. The prediction picks fewer when the
// data does not support more; this is the ceiling, not a target. Noted for a
// future free tier, where it would be the thing that gets capped.
const getPhaseCeiling = () => settings.get('phaseCeiling');

// How many predicted moments (sure/likely/maybe/long-shot) a single phase card
// will show — the same "ceiling, not a target" idea as getPhaseCeiling, one
// level down.
const getMomentCeiling = () => settings.get('momentCeiling');

module.exports = {
  getWorkHours,
  getBreaks,
  getTimeZone,
  getPhaseCeiling,
  getMomentCeiling,
  DEFAULTS,
  DEFAULT_BREAKS: settings.DEFAULT_BREAKS,
  // Re-exported: it was part of this module's surface before the parsing moved.
  parseBreaks: settings.parseBreaks,
};
