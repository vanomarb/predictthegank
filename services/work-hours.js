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
 */

const DEFAULTS = { start: 9, end: 18, days: [1, 2, 3, 4, 5] }; // Mon-Fri, 9am-6pm

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

module.exports = { getWorkHours, DEFAULTS };
