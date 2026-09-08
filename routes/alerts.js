const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Broadcast an alert to everyone currently viewing the app. Every click fires
// its own row — no dedup, no cooldown (unlike sighting logging).
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const row = await db.one(
      `INSERT INTO alerts (fired_by) VALUES ($1) RETURNING id, fired_by, created_at`,
      [req.user.id]
    );
    res.json({ id: row.id, firedBy: row.fired_by, firedByName: req.user.name, createdAt: row.created_at });
  } catch (e) {
    next(e);
  }
});

// optionalAuth, not requireAuth: the public landing page's anonymous visitors
// also need to see alerts, matching /sightings/stats's access pattern.
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const since = Number.parseInt(req.query.since, 10) || 0;
    const rows = await db.many(
      `SELECT a.id, a.fired_by, acc.name AS fired_by_name, a.created_at
       FROM alerts a
       JOIN accounts acc ON acc.id = a.fired_by
       WHERE a.id > $1
       ORDER BY a.id ASC
       LIMIT 20`,
      [since]
    );
    res.json({
      alerts: rows.map((r) => ({
        id: r.id, firedBy: r.fired_by, firedByName: r.fired_by_name, createdAt: r.created_at,
      })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
