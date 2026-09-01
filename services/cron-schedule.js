/**
 * What the scheduled prediction refresh is actually set to do.
 *
 * vercel.json's cron schedule is a fixed UTC string; when the working day ends
 * is configuration. The two can drift apart with no symptom other than the
 * prediction refreshing at the wrong time of day, which nobody would notice —
 * so server.js compares them out loud at boot, and the admin dashboard shows
 * both readings side by side.
 *
 * Lives here rather than in either caller because they were about to grow two
 * copies of the same timezone arithmetic.
 */

const fs = require('fs');
const path = require('path');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The UTC hour at which the office clock reads `localHour` today. Whole-hour
// offsets only, which covers every zone this is likely to run in; a half-hour
// zone (Asia/Kolkata) rounds, and callers say so.
function utcHourFor(localHour, timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false })
    .formatToParts(now);
  const here = Number.parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const offset = (here - now.getUTCHours() + 24) % 24;
  return ((localHour - offset) % 24 + 24) % 24;
}

// The office hour that a given UTC hour lands on — the inverse of the above,
// for turning the schedule as configured into the schedule as experienced.
function localHourFor(utcHour, timeZone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false })
    .formatToParts(now);
  const here = Number.parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const offset = (here - now.getUTCHours() + 24) % 24;
  return ((utcHour + offset) % 24 + 24) % 24;
}

// The refresh job from vercel.json, or null on a deploy that has no vercel.json
// (a VPS running `node server.js`, where an external crontab calls the route).
function refreshJob() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
    return (config.crons || []).find((c) => /refresh-prediction/.test(c.path)) || null;
  } catch (e) {
    return null;
  }
}

// 12-hour, like every other time in the app: "6pm", "9:30am", "12pm".
// The minutes are dropped when they are zero, because "6:00pm" reads as a
// precision the schedule does not have.
function h12(hour, minute = 0) {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return minute ? `${display}:${String(minute).padStart(2, '0')}${suffix}` : `${display}${suffix}`;
}

/**
 * Everything worth saying about the schedule, in one object the dashboard can
 * render and the boot check can compare against.
 */
function describeSchedule(timeZone, workHours) {
  const job = refreshJob();
  if (!job) {
    return {
      configured: false,
      note: 'No vercel.json cron found — this deploy expects an external scheduler '
        + 'to call GET /api/cron/refresh-prediction.',
    };
  }
  const fields = String(job.schedule).trim().split(/\s+/);
  const minute = Number.parseInt(fields[0], 10);
  const utcHour = Number.parseInt(fields[1], 10);
  const days = fields[4];
  const wantUtcHour = utcHourFor(workHours.end, timeZone);
  return {
    configured: true,
    path: job.path,
    schedule: job.schedule,
    utc: h12(utcHour, Number.isNaN(minute) ? 0 : minute),
    local: h12(localHourFor(utcHour, timeZone), Number.isNaN(minute) ? 0 : minute),
    timeZone,
    // Vercel's scheduler runs in UTC and Hobby projects get one run a day, so
    // the schedule is daily; the weekend skip lives in routes/cron.js, where the
    // work days are already configuration.
    everyDay: days === '*',
    skipsNonWorkDays: true,
    workDays: workHours.days.map((d) => DAY_NAMES[d]),
    endOfDay: h12(workHours.end),
    aligned: utcHour === wantUtcHour,
    shouldBe: `0 ${wantUtcHour} * * *`,
  };
}

module.exports = { utcHourFor, localHourFor, describeSchedule, refreshJob, h12 };
