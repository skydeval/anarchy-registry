-- Core tables: DIDs, handles, activity log, rate limit buckets.
-- See DESIGN.md §3. Timestamps are ISO 8601 UTC TEXT everywhere (sqlite has
-- no native datetime); epoch INTEGERs are reserved for rate-limit expiry
-- where arithmetic on "now" is hot.

CREATE TABLE IF NOT EXISTS dids (
    did         TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- /manage looks up the DID from a user's secret. UNIQUE because SHA-256
-- collisions from 119-bit-entropy inputs are astronomically unlikely —
-- we'd rather surface the violation as a hard error than silently route
-- two DIDs to the same secret.
CREATE UNIQUE INDEX IF NOT EXISTS dids_secret_hash_idx ON dids(secret_hash);

-- Handles -> DIDs. ON DELETE CASCADE so an admin "delete all handles for
-- this DID" collapses to `DELETE FROM dids WHERE did = ?`. The user-facing
-- "delete one handle, and if it was the last, drop the DID" path does the
-- opposite direction in a transaction (handles.rs).
CREATE TABLE IF NOT EXISTS handles (
    sub        TEXT PRIMARY KEY,
    did        TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (did) REFERENCES dids(did) ON DELETE CASCADE
);

-- §3: "handles.did — reverse lookup (find all handles for a DID)".
CREATE INDEX IF NOT EXISTS handles_did_idx ON handles(did);

-- Ring buffer capped at 1000 rows (§3). Pruned on each insert via a
-- trailing DELETE in the same transaction as the INSERT.
CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    event_type TEXT NOT NULL,
    did        TEXT,
    sub        TEXT,
    pds_host   TEXT
);

CREATE INDEX IF NOT EXISTS activity_log_ts_idx ON activity_log(ts);

-- Rate limit buckets. `expires_at` is unix epoch seconds — a background
-- sweep deletes rows where `expires_at < now`. The index supports that sweep.
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    key        TEXT PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_expires_idx
    ON rate_limit_buckets(expires_at);
