-- Replaces the single flat prediction with a ranked array of tiered windows
-- (sure / likely / maybe), matching the new multi-tier prediction UI. No real
-- data depended on the old flat columns (Gemini quota meant it stayed empty),
-- so this recreates the table rather than migrating column-by-column.
DROP TABLE IF EXISTS smart_predictions;

CREATE TABLE smart_predictions (
    id               BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    windows          JSONB NOT NULL,
    sightings_total  INTEGER NOT NULL,
    computed_at      BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);
