-- Distinguishes system/import accounts (e.g. the historical-data placeholder)
-- from real, login-capable team accounts. A system account can be attributed
-- in sighting_logs like any other account, but can never log in and never
-- counts toward "is anyone registered yet" bootstrap logic.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_system_not_admin;
ALTER TABLE accounts ADD CONSTRAINT accounts_system_not_admin CHECK (NOT (is_system AND is_admin));

UPDATE accounts SET is_system = true WHERE name = 'Anonymous';
