// One-off/idempotent seed: loads the pre-launch observation log (21-28 Aug 2026,
// 13 roams from a single unnamed observer) into Postgres so predictions have real
// history from day one. Safe to re-run — attributed to a placeholder "Anonymous"
// account (not a real login) and skips sightings it has already inserted.
//
// Run: node scripts/seed-historical.js
require('dotenv').config();
const db = require('../db');
const { getOrCreateSystemAccountId } = require('../services/system-accounts');

// Clock times as logged, in the app's configured TIMEZONE (Asia/Manila,
// UTC+8, no DST — see .env). Written with an explicit +08:00 offset so the
// stored instant is correct regardless of what timezone this script happens
// to run in.
const HISTORICAL_SIGHTINGS = [
  '2026-08-21T09:34:00+08:00',
  '2026-08-21T11:38:00+08:00',
  '2026-08-21T14:29:00+08:00',
  '2026-08-21T17:23:00+08:00',
  '2026-08-25T09:47:00+08:00',
  '2026-08-26T09:35:00+08:00',
  '2026-08-26T13:45:00+08:00',
  '2026-08-26T16:21:00+08:00',
  '2026-08-27T11:31:00+08:00',
  '2026-08-27T14:18:00+08:00',
  '2026-08-27T16:22:00+08:00',
  '2026-08-28T09:47:00+08:00',
  '2026-08-28T11:28:00+08:00',
];

(async () => {
  const accountId = await getOrCreateSystemAccountId(db, 'Anonymous');
  let inserted = 0, skipped = 0;

  for (const iso of HISTORICAL_SIGHTINGS) {
    const ts = Math.floor(new Date(iso).getTime() / 1000);

    const already = await db.one(
      `SELECT s.id FROM sightings s
       JOIN sighting_logs sl ON sl.sighting_id = s.id
       WHERE s.ts = $1 AND sl.account_id = $2`,
      [ts, accountId]
    );
    if (already) { skipped++; continue; }

    const sighting = await db.one('INSERT INTO sightings (ts) VALUES ($1) RETURNING id', [ts]);
    await db.query(
      'INSERT INTO sighting_logs (sighting_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [sighting.id, accountId]
    );
    inserted++;
  }

  console.log(`Seeded ${inserted} historical sighting(s), skipped ${skipped} already present.`);
  console.log('Next: open /admin and register — the first real account becomes admin automatically, no invite needed.');

  await db.pool.end();
})().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
