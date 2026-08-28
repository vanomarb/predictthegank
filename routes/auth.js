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

// Register requires a valid, unused invite code.
router.post('/register', async (req, res) => {
  const { name, password, inviteCode } = req.body || {};
  if (!isValidName(name)) return res.status(400).json({ error: 'Name must be 2-40 characters.' });
  if (!isValidPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!inviteCode) return res.status(400).json({ error: 'An invite code is required.' });

  const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(inviteCode.trim());
  if (!invite) return res.status(400).json({ error: 'Invalid invite code.' });
  if (invite.used_by) return res.status(400).json({ error: 'That invite code has already been used.' });

  const cleanName = name.trim();
  const existing = db.prepare('SELECT id FROM accounts WHERE lower(name) = lower(?)').get(cleanName);
  if (existing) return res.status(400).json({ error: 'That name is already registered.' });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // First account ever created becomes admin automatically.
  const accountCount = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const isAdmin = accountCount === 0 ? 1 : 0;

  const insert = db.prepare(
    'INSERT INTO accounts (name, password_hash, is_admin) VALUES (?, ?, ?)'
  );
  const info = insert.run(cleanName, passwordHash, isAdmin);

  db.prepare('UPDATE invites SET used_by = ?, used_at = strftime(\'%s\',\'now\') WHERE code = ?')
    .run(info.lastInsertRowid, inviteCode.trim());

  const account = { id: info.lastInsertRowid, name: cleanName, is_admin: isAdmin };
  const token = signToken(account);
  res.cookie('session', token, COOKIE_OPTS);
  res.json({ name: account.name, isAdmin: !!isAdmin });
});

router.post('/login', async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'Name and password required.' });

  const account = db.prepare('SELECT * FROM accounts WHERE lower(name) = lower(?)').get(name.trim());
  if (!account) return res.status(401).json({ error: 'Name and password don\'t match.' });

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
router.post('/invites', requireAuth, requireAdmin, (req, res) => {
  const code = crypto.randomBytes(6).toString('hex'); // 12-char code
  db.prepare('INSERT INTO invites (code, created_by) VALUES (?, ?)').run(code, req.user.id);
  res.json({ code });
});

// Admin: list invites and their status.
router.get('/invites', requireAuth, requireAdmin, (req, res) => {
  const invites = db.prepare(`
    SELECT i.code, i.created_at, i.used_at, u.name AS used_by
    FROM invites i
    LEFT JOIN accounts u ON u.id = i.used_by
    ORDER BY i.created_at DESC
  `).all();
  res.json({ invites });
});

module.exports = router;
