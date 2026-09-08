-- Login is now nickname-only (see routes/auth.js /enter): no invite code, no
-- password. Whoever knows a nickname re-enters that account; the invite
-- system and password hashes have no purpose left.
DROP TABLE IF EXISTS invites;
ALTER TABLE accounts DROP COLUMN IF EXISTS password_hash;
