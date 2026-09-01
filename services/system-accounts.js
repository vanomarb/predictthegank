const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Gets or creates a non-login-capable account (is_system = true) by name —
// used both for the historical-data placeholder and for anonymous public logs.
// Shared so both callers stay consistent about what "system account" means.
async function getOrCreateSystemAccountId(db, name) {
  const existing = await db.one('SELECT id FROM accounts WHERE name = $1', [name]);
  if (existing) return existing.id;

  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const inserted = await db.one(
    'INSERT INTO accounts (name, password_hash, is_admin, is_system) VALUES ($1, $2, false, true) RETURNING id',
    [name, passwordHash]
  );
  return inserted.id;
}

module.exports = { getOrCreateSystemAccountId };
