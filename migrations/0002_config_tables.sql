-- Five config lookup tables with identical schema (§3). Split rather than
-- unified as `config_lists(kind, value, ...)` because:
--   (a) query patterns differ per list (exact-match vs substring for
--       keywords)
--   (b) growth rates differ (reserved handles churn; blocked DIDs sit)
--   (c) schema can evolve independently — e.g. adding `expires_at` to
--       blocked keywords later without touching VIPs.
-- `value` is always the already-normalized (lowercase, trimmed) form.

CREATE TABLE IF NOT EXISTS config_vip_dids (
    value    TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    note     TEXT
);

CREATE TABLE IF NOT EXISTS config_blocked_dids (
    value    TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    note     TEXT
);

CREATE TABLE IF NOT EXISTS config_blocked_pds (
    value    TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    note     TEXT
);

CREATE TABLE IF NOT EXISTS config_blocked_keywords (
    value    TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    note     TEXT
);

CREATE TABLE IF NOT EXISTS config_reserved_handles (
    value    TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    note     TEXT
);
