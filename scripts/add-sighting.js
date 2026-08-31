/**
 * Records sightings at specific times, for seeding and for checking the page
 * against known data.
 *
 *   node scripts/add-sighting.js 9:37am 2:09pm
 *   node scripts/add-sighting.js 14:09                 # 24h also works
 *   node scripts/add-sighting.js --date 2026-08-28 9:37am
 *   node scripts/add-sighting.js --dry-run 9:37am
 *
 * The "I see them" button can only ever log the current minute, which is right
 * for the button and useless for filling in a time that has already passed or
 * for setting up a known state to look at. This does the same insert the button
 * does, at a time you name.
 *
 * Times are read on the office clock (TIMEZONE), the same clock the heatmap
 * buckets into and the predictions are stated in — so "9:37am" here is the
 * 9:37am the page will show, whatever timezone the machine running this is in.
 *
 * Attributed to the shared "Seeded" system account rather than a real person:
 * these are not sightings anybody witnessed, and per-person attribution on the
 * admin console should not claim otherwise.
 */

require('dotenv').config();
const db = require('../db');
const { getOrCreateSystemAccountId } = require('../services/system-accounts');

const TIMEZONE = process.env.TIMEZONE || 'UTC';
const ACCOUNT = 'Seeded';
// The same window the API uses to merge near-simultaneous logs. Seeding inside
// it would attach to an existing sighting instead of making a new one, which is
// almost never what someone running this wants, so it is called out instead.
const DEDUP_WINDOW_SECONDS = 2 * 60;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// "9:37am" | "2:09pm" | "14:09" | "9.37am" -> minutes since local midnight.
function parseTime(raw) {
  const m = /^(\d{1,2})[:.]?(\d{2})\s*(am|pm)?$/i.exec(String(raw).trim());
  if (!m) return null;
  let hour = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  const suffix = (m[3] || '').toLowerCase();
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;
  return hour * 60 + minute;
}

// The unix second at which the office clock reads `date` at `minutes`.
//
// Done by search rather than arithmetic: an offset is not a constant (DST), and
// this is the one place in the app that has to go from a wall-clock time BACK to
// an instant. Two passes of Intl formatting is cheap and cannot drift.
function instantFor(dateStr, minutes) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const reads = (ts) => {
    const parts = fmt.formatToParts(new Date(ts * 1000));
    const get = (t) => parts.find((p) => p.type === t).value;
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      minutes: (Number.parseInt(get('hour'), 10) % 24) * 60 + Number.parseInt(get('minute'), 10),
    };
  };

  // Start from the naive UTC guess, then correct by whatever it is out by.
  let ts = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000) + minutes * 60;
  for (let i = 0; i < 4; i += 1) {
    const got = reads(ts);
    if (got.date === dateStr && got.minutes === minutes) return ts;
    const dayDelta = (Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${got.date}T00:00:00Z`)) / 1000;
    ts += dayDelta + (minutes - got.minutes) * 60;
  }
  return null;
}

function todayInTZ() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The button's insert, at a time of our choosing. Same dedup check, so seeding
// twice does not silently double a sighting.
async function addAt(ts, accountId, dryRun) {
  // A dry run touches nothing, not even to read: its job is to let the time
  // parsing and the timezone maths be checked without a database in reach.
  if (dryRun) return { skipped: false, id: null };
  const recent = await db.one(
    'SELECT id, ts FROM sightings WHERE ABS(ts - $1) < $2 ORDER BY ABS(ts - $1) ASC LIMIT 1',
    [ts, DEDUP_WINDOW_SECONDS]
  );
  if (recent) return { skipped: true, existingId: recent.id };

  const inserted = await db.one('INSERT INTO sightings (ts) VALUES ($1) RETURNING id', [ts]);
  await db.query(
    `INSERT INTO sighting_logs (sighting_id, account_id) VALUES ($1, $2)
     ON CONFLICT (sighting_id, account_id) DO NOTHING`,
    [inserted.id, accountId]
  );
  return { skipped: false, id: inserted.id };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dateIdx = args.indexOf('--date');
  const date = dateIdx === -1 ? todayInTZ() : args[dateIdx + 1];
  // dateIdx + 1 is the value belonging to --date. Guard on dateIdx !== -1: with
  // no --date present dateIdx is -1, so "skip dateIdx + 1" would skip index 0
  // — silently dropping the FIRST time given, which is exactly what it did.
  const dateValueIdx = dateIdx === -1 ? -1 : dateIdx + 1;
  const times = args.filter((a, i) => !a.startsWith('--') && i !== dateValueIdx);

  if (times.length === 0) {
    fail('usage: node scripts/add-sighting.js [--date YYYY-MM-DD] [--dry-run] <time> [time...]\n'
      + '   eg: node scripts/add-sighting.js 9:37am 2:09pm');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got "${date}"`);

  const parsed = times.map((t) => {
    const minutes = parseTime(t);
    if (minutes === null) fail(`could not read "${t}" as a time — try 9:37am, 2:09pm or 14:09`);
    const ts = instantFor(date, minutes);
    if (ts === null) fail(`could not place ${t} on ${date} in ${TIMEZONE}`);
    return { input: t, minutes, ts };
  });

  console.log(`timezone ${TIMEZONE}, date ${date}${dryRun ? '  (dry run — nothing will be written)' : ''}`);
  const accountId = dryRun ? null : await getOrCreateSystemAccountId(db, ACCOUNT);

  for (const p of parsed) {
    const shown = `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:`
      + `${String(p.minutes % 60).padStart(2, '0')}`;
    const res = await addAt(p.ts, accountId, dryRun);
    if (res.skipped) {
      console.log(`  ${p.input.padEnd(8)} -> ${shown}  already have a sighting within `
        + `${DEDUP_WINDOW_SECONDS / 60} min (id ${res.existingId}) — skipped`);
    } else if (dryRun) {
      console.log(`  ${p.input.padEnd(8)} -> ${shown}  would insert at ts ${p.ts}`);
    } else {
      console.log(`  ${p.input.padEnd(8)} -> ${shown}  inserted, sighting id ${res.id}`);
    }
  }

  if (!dryRun) {
    console.log('\nThe statistical prediction picks these up on the next page poll.');
    console.log('The Gemini one refreshes at the next cron run (see routes/cron.js).');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
