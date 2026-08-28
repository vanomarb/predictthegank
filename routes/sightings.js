const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const DEDUP_WINDOW_SECONDS = 2 * 60;

router.use(requireAuth);

// Log a sighting now. Merges into an existing sighting within the dedup window
// instead of creating a duplicate.
router.post('/', (req, res) => {
  const now = Math.floor(Date.now() / 1000);

  const recent = db.prepare(
    'SELECT * FROM sightings WHERE ABS(ts - ?) < ? ORDER BY ABS(ts - ?) ASC LIMIT 1'
  ).get(now, DEDUP_WINDOW_SECONDS, now);

  let sightingId, merged = false;

  if (recent) {
    sightingId = recent.id;
    const already = db.prepare(
      'SELECT 1 FROM sighting_logs WHERE sighting_id = ? AND account_id = ?'
    ).get(sightingId, req.user.id);
    if (already) {
      return res.json({ merged: true, alreadyLogged: true, sightingId });
    }
    merged = true;
  } else {
    const info = db.prepare('INSERT INTO sightings (ts) VALUES (?)').run(now);
    sightingId = info.lastInsertRowid;
  }

  db.prepare('INSERT INTO sighting_logs (sighting_id, account_id) VALUES (?, ?)')
    .run(sightingId, req.user.id);

  res.json({ merged, alreadyLogged: false, sightingId });
});

// Undo the current user's most recent contribution.
router.delete('/mine/latest', (req, res) => {
  const row = db.prepare(`
    SELECT sl.sighting_id, s.id AS sighting_row_id,
           (SELECT COUNT(*) FROM sighting_logs WHERE sighting_id = sl.sighting_id) AS logger_count
    FROM sighting_logs sl
    JOIN sightings s ON s.id = sl.sighting_id
    WHERE sl.account_id = ?
    ORDER BY sl.logged_at DESC
    LIMIT 1
  `).get(req.user.id);

  if (!row) return res.status(404).json({ error: 'Nothing to undo.' });

  db.prepare('DELETE FROM sighting_logs WHERE sighting_id = ? AND account_id = ?')
    .run(row.sighting_id, req.user.id);

  if (row.logger_count <= 1) {
    db.prepare('DELETE FROM sightings WHERE id = ?').run(row.sighting_id);
  }

  res.json({ ok: true });
});

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.ts, GROUP_CONCAT(a.name, ', ') AS logged_by
    FROM sightings s
    JOIN sighting_logs sl ON sl.sighting_id = s.id
    JOIN accounts a ON a.id = sl.account_id
    GROUP BY s.id
    ORDER BY s.ts DESC
    LIMIT 500
  `).all();
  res.json({ sightings: rows });
});

router.get('/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT s.ts, GROUP_CONCAT(a.name, ', ') AS logged_by
    FROM sightings s
    JOIN sighting_logs sl ON sl.sighting_id = s.id
    JOIN accounts a ON a.id = sl.account_id
    GROUP BY s.id
  `).all();

  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const byPerson = {};
  rows.forEach(r => {
    const d = new Date(r.ts * 1000);
    heatmap[d.getDay()][d.getHours()]++;
    r.logged_by.split(', ').forEach(n => { byPerson[n] = (byPerson[n] || 0) + 1; });
  });

  let best = null, bestCount = 0;
  heatmap.forEach((hours, day) => {
    hours.forEach((count, hour) => {
      if (count > bestCount) { bestCount = count; best = { day, hour }; }
    });
  });

  res.json({
    total: rows.length,
    heatmap,
    byPerson,
    prediction: best ? { ...best, count: bestCount, pct: Math.round((bestCount / rows.length) * 100) } : null,
  });
});

module.exports = router;
