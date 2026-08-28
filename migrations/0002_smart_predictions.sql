-- Persists the last Gemini-refined prediction so it's computed once per logged
-- sighting (in routes/sightings.js, triggered from POST /api/sightings) instead
-- of on every /api/sightings/stats poll — the public page polls that endpoint
-- every 5s and must never itself trigger a Gemini call.
CREATE TABLE IF NOT EXISTS smart_predictions (
    id                    BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    predicted_day         SMALLINT NOT NULL,
    predicted_hour_start  SMALLINT NOT NULL,
    predicted_hour_end    SMALLINT NOT NULL,
    confidence            REAL NOT NULL,
    rationale             TEXT NOT NULL,
    sightings_total       INTEGER NOT NULL,
    computed_at           BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);
