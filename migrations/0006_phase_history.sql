-- Freezes each work day's own served phases (statistical, and the AI ones if
-- in use) once, right when that day's work hours close — see the snapshot
-- step in routes/cron.js, called from GET /api/cron/refresh-prediction before
-- it recomputes the AI prediction for the next day.
--
-- Without this, the field log's day-by-day timeline (public/viz.js
-- renderDayTimeline) re-judged every past day against whatever the CURRENT
-- live pattern happens to be — so a day's own Hit/Missed verdict could flip
-- days later as new sightings shifted the statistical median or the AI's read
-- of the pattern. This table is what makes a day's record permanent.
--
-- Degrades like app_settings (migrations/0005): a deploy that has not run
-- this migration falls back to judging every day against the live pattern,
-- exactly as it did before this table existed — see the UNDEFINED_TABLE
-- handling in routes/sightings.js.
CREATE TABLE IF NOT EXISTS phase_history (
    date          TEXT PRIMARY KEY,
    windows       JSONB NOT NULL,
    smart_windows JSONB,
    computed_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);
