-- Broadcast "X pressed the alert button" events. Alert-only, no free text —
-- fired_by identifies who, id/created_at establish "new since I last polled".
-- No dedup window (unlike sightings): every click is its own row by design.
CREATE TABLE IF NOT EXISTS alerts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fired_by   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_alerts_id ON alerts(id DESC);
