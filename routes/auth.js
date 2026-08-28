const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdmin, signToken } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

function isValidName(name) {
  return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 40;
}
function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8;
}

// True until the first real admin exists — mirrors Coolify's first-run flow:
// whoever registers before any admin exists becomes admin with no invite
// needed; every registration after that requires one. A system/placeholder
// account (e.g. the historical-data import) never counts as that admin.
async function needsBootstrap() {
  const { n: adminCount } = await db.one('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = true');
  return adminCount === 0;
}

// Public: lets the registration UI know whether to ask for an invite code at all.
router.get('/register-status', async (req, res) => {
  res.json({ needsBootstrap: await needsBootstrap() });
});

router.post('/register', async (req, res) => {
  const { name, password, inviteCode } = req.body || {};
  if (!isValidName(name)) return res.status(400).json({ error: 'Name must be 2-40 characters.' });
  if (!isValidPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const bootstrap = await needsBootstrap();

  let invite = null;
  if (!bootstrap) {
    if (!inviteCode) return res.status(400).json({ error: 'An invite code is required.' });
    invite = await db.one('SELECT * FROM invites WHERE code = $1', [inviteCode.trim()]);
    if (!invite) return res.status(400).json({ error: 'Invalid invite code.' });
    if (invite.used_by) return res.status(400).json({ error: 'That invite code has already been used.' });
  }

  const cleanName = name.trim();
  const existing = await db.one('SELECT id FROM accounts WHERE lower(name) = lower($1)', [cleanName]);
  if (existing) return res.status(400).json({ error: 'That name is already registered.' });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const isAdmin = bootstrap;

  const inserted = await db.one(
    'INSERT INTO accounts (name, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id',
    [cleanName, passwordHash, isAdmin]
  );

  if (invite) {
    await db.query(
      "UPDATE invites SET used_by = $1, used_at = EXTRACT(EPOCH FROM now())::bigint WHERE code = $2",
      [inserted.id, invite.code]
    );
  }

  const account = { id: inserted.id, name: cleanName, is_admin: isAdmin };
  const token = signToken(account);
  res.cookie('session', token, COOKIE_OPTS);
  res.json({ name: account.name, isAdmin: !!isAdmin });
});

router.post('/login', async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'Name and password required.' });

  const account = await db.one('SELECT * FROM accounts WHERE lower(name) = lower($1)', [name.trim()]);
  // System/import accounts (e.g. the historical-data placeholder) are never
  // login-capable, regardless of what's in password_hash.
  if (!account || account.is_system) return res.status(401).json({ error: 'Name and password don\'t match.' });

  const ok = await bcrypt.compare(password, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Name and password don\'t match.' });

  const token = signToken(account);
  res.cookie('session', token, COOKIE_OPTS);
  res.json({ name: account.name, isAdmin: !!account.is_admin });
});

router.post('/logout', (req, res) => {
  res.clearCookie('session', COOKIE_OPTS);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ name: req.user.name, isAdmin: req.user.isAdmin });
});

// Admin: generate a new single-use invite code.
router.post('/invites', requireAuth, requireAdmin, async (req, res) => {
  const code = crypto.randomBytes(6).toString('hex'); // 12-char code
  await db.query('INSERT INTO invites (code, created_by) VALUES ($1, $2)', [code, req.user.id]);
  res.json({ code });
});

// Admin: list invites and their status.
router.get('/invites', requireAuth, requireAdmin, async (req, res) => {
  const invites = await db.many(`
    SELECT i.code, i.created_at, i.used_at, u.name AS used_by
    FROM invites i
    LEFT JOIN accounts u ON u.id = i.used_by
    ORDER BY i.created_at DESC
  `);
  res.json({ invites });
});

module.exports = router;
