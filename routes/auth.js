const express = require('express');
const db = require('../db');
const { requireAuth, signToken } = require('../middleware/auth');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

const NICKNAME_RE = /^[A-Za-z0-9_-]{1,8}$/;
function isValidNickname(name) {
  return typeof name === 'string' && NICKNAME_RE.test(name);
}

// True until the first real admin exists — mirrors Coolify's first-run flow:
// whoever enters a nickname before any admin exists becomes admin. A
// system/placeholder account (e.g. the historical-data import) never counts
// as that admin.
async function needsBootstrap() {
  const { n: adminCount } = await db.one('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = true');
  return adminCount === 0;
}

// The whole auth surface: no password, no invite code. A nickname that
// already exists logs back into that same account; a new one creates it.
// This is a small trusted-team tool — the simplicity is the point, and
// whoever knows a teammate's nickname can act as them (accepted tradeoff).
router.post('/enter', async (req, res) => {
  const { name } = req.body || {};
  if (!isValidNickname(name)) {
    return res.status(400).json({ error: 'Nickname must be 1-8 characters: letters, numbers, - or _.' });
  }

  let account = await db.one('SELECT * FROM accounts WHERE lower(name) = lower($1)', [name]);
  if (account && account.is_system) {
    return res.status(400).json({ error: 'That name is reserved.' });
  }

  if (!account) {
    const isAdmin = await needsBootstrap();
    account = await db.one(
      'INSERT INTO accounts (name, is_admin) VALUES ($1, $2) RETURNING *',
      [name, isAdmin]
    );
  }

  const token = signToken(account);
  res.cookie('session', token, COOKIE_OPTS);
  res.json({ id: account.id, name: account.name, isAdmin: !!account.is_admin });
});

router.post('/logout', (req, res) => {
  res.clearCookie('session', COOKIE_OPTS);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, isAdmin: req.user.isAdmin });
});

module.exports = router;
