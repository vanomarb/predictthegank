/**
 * The one definition of "work hours" — the window in which logging a sighting
 * is allowed at all.
 *
 * It lives server-side and ships to the browser through /api/config for the
 * same reason the heatmap's timezone does: the team's working day is a property
 * of the office, not of whichever timezone a given viewer's laptop is set to.
 * A viewer in another country still sees the button enabled and disabled on the
 * office's clock.
 *
 * Configured with WORK_HOURS_START / WORK_HOURS_END / WORK_DAYS (see
 * .env.example). Hours are inclusive of the start and exclusive of the end, so
 * 9-18 means the button goes live at 09:00 and dies at 18:00 sharp.
 *
 * BREAK_TIMES carves the breaks back out of that day. HR is not roaming during
 * lunch, so a sighting logged then says nothing about the pattern and a
 * prediction landing there is one nobody should act on — predictions skip those
 * minutes entirely. Logging is deliberately NOT blocked during a break: if HR
 * really does walk past at 12:30, that is worth recording even though it is not
 * something to forecast from.
 */

const DEFAULTS = { start: 9, end: 18, days: [1, 2, 3, 4, 5] }; // Mon-Fri, 9am-6pm
// Lunch, and the afternoon break. Minutes since midnight, end exclusive.
const DEFAULT_BREAKS = '12:00-13:00,15:15-15:30';

function parseHour(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n <= 24 ? n : fallback;
}

// "1-5" or "1,2,3,4,5" or "0,6" — 0 is Sunday, matching JS getDay() and the
// heatmap's own day indexing.
function parseDays(raw, fallback) {
  if (!raw) return fallback;
  const range = /^\s*(\d)\s*-\s*(\d)\s*$/.exec(raw);
  let days;
  if (range) {
    const [, from, to] = range.map(Number);
    days = [];
    for (let d = from; d <= to; d += 1) days.push(d);
  } else {
    days = raw.split(',').map((p) => Number.parseInt(p.trim(), 10));
  }
  days = [...new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  return days.length ? days : fallback;
}

function getWorkHours() {
  const start = parseHour(process.env.WORK_HOURS_START, DEFAULTS.start);
  const end = parseHour(process.env.WORK_HOURS_END, DEFAULTS.end);
  return {
    // A start at or past the end would silently disable the button forever,
    // which is a very confusing way to learn about a typo in .env.
    start: end > start ? start : DEFAULTS.start,
    end: end > start ? end : DEFAULTS.end,
    days: parseDays(process.env.WORK_DAYS, DEFAULTS.days),
  };
}

// "12:00-13:00,15:15-15:30" -> [{ start: 720, end: 780 }, { start: 915, end: 930 }],
// in minutes since midnight, end exclusive. Anything unparseable is dropped
// rather than defaulted: a typo that silently invents a break in the middle of
// the afternoon is worse than one that goes missing and gets noticed.
function parseBreaks(raw) {
  const text = raw == null || raw.trim() === '' ? DEFAULT_BREAKS : raw;
  const minutes = (hh, mm) => hh * 60 + mm;
  return text.split(',')
    .map((part) => /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part))
    .filter(Boolean)
    .map((m) => ({ start: minutes(+m[1], +m[2]), end: minutes(+m[3], +m[4]) }))
    .filter((b) => b.end > b.start && b.start >= 0 && b.end <= 24 * 60)
    .sort((a, b) => a.start - b.start);
}

function getBreaks() {
  return parseBreaks(process.env.BREAK_TIMES);
}

module.exports = { getWorkHours, getBreaks, DEFAULTS, DEFAULT_BREAKS };
