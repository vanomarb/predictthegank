CREATE TABLE IF NOT EXISTS accounts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT false,
    created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE TABLE IF NOT EXISTS invites (
    code        TEXT PRIMARY KEY,
    created_by  BIGINT REFERENCES accounts(id),
    created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint,
    used_by     BIGINT REFERENCES accounts(id),
    used_at     BIGINT
);

CREATE TABLE IF NOT EXISTS sightings (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts         BIGINT NOT NULL,
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint
);

CREATE TABLE IF NOT EXISTS sighting_logs (
    sighting_id BIGINT NOT NULL REFERENCES sightings(id) ON DELETE CASCADE,
    account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    logged_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM now())::bigint,
    PRIMARY KEY (sighting_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_sightings_ts ON sightings(ts);
CREATE INDEX IF NOT EXISTS idx_sighting_logs_account ON sighting_logs(account_id);
