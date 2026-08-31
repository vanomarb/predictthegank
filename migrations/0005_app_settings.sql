-- Runtime settings an admin can change from the dashboard, without a redeploy.
--
-- The AI model is the first of them. It used to be GEMINI_MODEL in the
-- environment, which on Vercel means an env-var edit and a redeploy to try a
-- different model — and no way for anyone reading the page to see which model
-- produced the prediction they are looking at.
--
-- Key/value rather than a column per setting: these are operator knobs read a
-- handful of times a day, not app data, and a new one should not need a
-- migration. Everything stored here has an environment-variable fallback, so a
-- deploy that has not run this migration yet behaves exactly as it did before.
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    -- Who changed it and when, because "why is it pointing at that model?" is a
    -- question someone will ask eventually.
    updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint,
    updated_by BIGINT REFERENCES accounts(id) ON DELETE SET NULL
);
