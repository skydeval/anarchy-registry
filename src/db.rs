//! SQLite access layer.
//!
//! The schema is defined in `migrations/` per DESIGN.md §3; sqlx runs
//! those files on startup. This module owns:
//!
//! - `connect()`: pool construction with the PRAGMAs §3/§4.5 require
//!   (WAL, foreign keys, busy timeout) and an integrity check that
//!   refuses to start on a corrupt database (§3 startup behavior).
//! - Row structs mirroring the §3 tables.
//! - CRUD primitives grouped by concern (handles/DIDs, config lists,
//!   activity log, rate-limit buckets).
//!
//! Anything that spans multiple rows — first-time DID registration,
//! last-handle-deletion-drops-DID, activity-log-prune-on-insert, rate-
//! limit increment — happens inside an explicit transaction. That's
//! §4.5's "either both succeed or neither does" made concrete.

use std::str::FromStr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::error::{AppError, AppResult};

// ==================================================================
// connect + startup
// ==================================================================

/// Open a pool against `database_url`, run migrations, and refuse to
/// start if the database is corrupt or ahead of our known migrations.
pub async fn connect(database_url: &str) -> AppResult<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(opts)
        .await?;

    // §3: refuse to start on corruption.
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&pool)
        .await?;
    if integrity != "ok" {
        return Err(AppError::Internal(format!(
            "database integrity check failed: {integrity}"
        )));
    }

    // §3: sqlx returns an error if the live DB has migrations our binary
    // doesn't know about (the rollback scenario). We surface that as an
    // Internal error so systemd sees the failure and stops restarting.
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| AppError::Internal(format!("migration failed: {e}")))?;

    Ok(pool)
}

// ==================================================================
// row types
// ==================================================================

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct HandleRow {
    pub sub: String,
    pub did: String,
    pub created_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct DidRow {
    pub did: String,
    pub secret_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct ConfigRow {
    pub value: String,
    pub added_at: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ActivityRow {
    pub id: i64,
    pub ts: String,
    pub event_type: String,
    pub did: Option<String>,
    pub sub: Option<String>,
    pub pds_host: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    NotFound,
    Deleted { did_dropped: bool },
}

// ==================================================================
// handles + DIDs
// ==================================================================

pub async fn get_did(pool: &SqlitePool, did: &str) -> AppResult<Option<DidRow>> {
    Ok(
        sqlx::query_as("SELECT did, secret_hash, created_at FROM dids WHERE did = ?")
            .bind(did)
            .fetch_optional(pool)
            .await?,
    )
}

/// /manage entry point: given the hashed secret, find its owning DID.
/// Backed by the unique index on `dids.secret_hash`.
pub async fn find_did_by_secret_hash(
    pool: &SqlitePool,
    secret_hash: &str,
) -> AppResult<Option<DidRow>> {
    Ok(
        sqlx::query_as("SELECT did, secret_hash, created_at FROM dids WHERE secret_hash = ?")
            .bind(secret_hash)
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn get_handle_by_sub(
    pool: &SqlitePool,
    sub: &str,
) -> AppResult<Option<HandleRow>> {
    Ok(
        sqlx::query_as("SELECT sub, did, created_at FROM handles WHERE sub = ?")
            .bind(sub)
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn list_handles_for_did(
    pool: &SqlitePool,
    did: &str,
) -> AppResult<Vec<HandleRow>> {
    Ok(sqlx::query_as(
        "SELECT sub, did, created_at FROM handles WHERE did = ? ORDER BY created_at ASC",
    )
    .bind(did)
    .fetch_all(pool)
    .await?)
}

pub async fn count_handles_for_did(pool: &SqlitePool, did: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM handles WHERE did = ?")
        .bind(did)
        .fetch_one(pool)
        .await?)
}

/// Atomically register a brand-new DID + its first handle (§4.5).
///
/// A concurrent registrant claiming the same sub raises a sqlx
/// unique-constraint error; callers can use `is_unique_violation` to
/// map that to `AppError::HandleUnavailable` without conflating it
/// with real database failures.
pub async fn register_new_did_with_handle(
    pool: &SqlitePool,
    did: &str,
    secret_hash: &str,
    sub: &str,
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO dids (did, secret_hash, created_at) VALUES (?, ?, ?)")
        .bind(did)
        .bind(secret_hash)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO handles (sub, did, created_at) VALUES (?, ?, ?)")
        .bind(sub)
        .bind(did)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Append a handle to an already-existing DID. Caller verified the DID
/// row exists (via `get_did`) and that the per-DID handle cap is not
/// exceeded (via `count_handles_for_did`).
pub async fn add_handle(pool: &SqlitePool, did: &str, sub: &str) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO handles (sub, did, created_at) VALUES (?, ?, ?)")
        .bind(sub)
        .bind(did)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete one handle owned by `did`. If it was the DID's last handle,
/// the DID row is dropped in the same transaction (§7: "deleting the
/// last handle for a DID removes the DID record entirely").
pub async fn delete_handle_and_maybe_did(
    pool: &SqlitePool,
    did: &str,
    sub: &str,
) -> AppResult<DeleteOutcome> {
    let mut tx = pool.begin().await?;
    let res = sqlx::query("DELETE FROM handles WHERE sub = ? AND did = ?")
        .bind(sub)
        .bind(did)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 0 {
        tx.rollback().await?;
        return Ok(DeleteOutcome::NotFound);
    }
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM handles WHERE did = ?")
        .bind(did)
        .fetch_one(&mut *tx)
        .await?;
    let did_dropped = remaining == 0;
    if did_dropped {
        sqlx::query("DELETE FROM dids WHERE did = ?")
            .bind(did)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(DeleteOutcome::Deleted { did_dropped })
}

/// Admin: remove a DID and every handle it owns. Relies on the FK
/// `ON DELETE CASCADE` in 0001_init.sql.
pub async fn delete_did_and_handles(pool: &SqlitePool, did: &str) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM dids WHERE did = ?")
        .bind(did)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Admin dashboard: every DID and the subs it owns, ordered by DID.
/// One query returning flat rows; caller groups by DID if needed.
pub async fn list_all_did_handle_pairs(
    pool: &SqlitePool,
) -> AppResult<Vec<(String, String, String)>> {
    let rows = sqlx::query(
        "SELECT d.did, h.sub, h.created_at
         FROM dids d
         LEFT JOIN handles h ON h.did = d.did
         ORDER BY d.did, h.created_at",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get::<String, _>("did"),
                r.get::<Option<String>, _>("sub").unwrap_or_default(),
                r.get::<Option<String>, _>("created_at").unwrap_or_default(),
            )
        })
        .collect())
}

// ==================================================================
// config lists (five tables, identical schema — §3)
// ==================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigList {
    VipDids,
    BlockedDids,
    BlockedPds,
    BlockedKeywords,
    ReservedHandles,
}

impl ConfigList {
    /// Table name. Sourced from a closed enum (not user input) — safe to
    /// interpolate into SQL.
    fn table(self) -> &'static str {
        match self {
            ConfigList::VipDids => "config_vip_dids",
            ConfigList::BlockedDids => "config_blocked_dids",
            ConfigList::BlockedPds => "config_blocked_pds",
            ConfigList::BlockedKeywords => "config_blocked_keywords",
            ConfigList::ReservedHandles => "config_reserved_handles",
        }
    }
}

pub async fn config_contains(
    pool: &SqlitePool,
    list: ConfigList,
    value: &str,
) -> AppResult<bool> {
    let sql = format!("SELECT 1 FROM {} WHERE value = ? LIMIT 1", list.table());
    let row: Option<i64> = sqlx::query_scalar(&sql)
        .bind(value)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

pub async fn config_list_all(
    pool: &SqlitePool,
    list: ConfigList,
) -> AppResult<Vec<ConfigRow>> {
    let sql = format!(
        "SELECT value, added_at, note FROM {} ORDER BY added_at DESC",
        list.table()
    );
    Ok(sqlx::query_as(&sql).fetch_all(pool).await?)
}

/// Insert or update-in-place. Re-adding refreshes the note and timestamp,
/// matching the worker's behavior and the operator's mental model
/// ("re-adding with a new note").
pub async fn config_add(
    pool: &SqlitePool,
    list: ConfigList,
    value: &str,
    note: Option<&str>,
) -> AppResult<()> {
    let sql = format!(
        "INSERT INTO {} (value, added_at, note) VALUES (?, ?, ?)
         ON CONFLICT(value) DO UPDATE
            SET note = excluded.note, added_at = excluded.added_at",
        list.table()
    );
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(&sql)
        .bind(value)
        .bind(now)
        .bind(note)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn config_remove(
    pool: &SqlitePool,
    list: ConfigList,
    value: &str,
) -> AppResult<bool> {
    let sql = format!("DELETE FROM {} WHERE value = ?", list.table());
    let res = sqlx::query(&sql).bind(value).execute(pool).await?;
    Ok(res.rows_affected() > 0)
}

/// Does the sub contain any blocked keyword as a substring? One round-trip
/// via SQLite's LIKE.
pub async fn handle_has_blocked_keyword(
    pool: &SqlitePool,
    sub: &str,
) -> AppResult<bool> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM config_blocked_keywords
         WHERE ? LIKE '%' || value || '%' LIMIT 1",
    )
    .bind(sub)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Preview the blast radius of a keyword before adding it (§5,
/// admin preview-keyword): handles currently registered that would
/// be caught.
pub async fn handles_matching_keyword(
    pool: &SqlitePool,
    keyword: &str,
) -> AppResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT sub FROM handles WHERE sub LIKE '%' || ? || '%' ORDER BY sub",
    )
    .bind(keyword)
    .fetch_all(pool)
    .await?)
}

// ==================================================================
// activity log (ring buffer, §3)
// ==================================================================

pub const ACTIVITY_LOG_CAP: i64 = 1000;

#[derive(Debug, Clone, Copy)]
pub enum EventType {
    Register,
    Delete,
    RegisterBlockedDid,
    RegisterBlockedPds,
    RegisterBlockedKeyword,
    AdminAssignReserved,
    AdminDeleteAll,
}

impl EventType {
    fn as_str(self) -> &'static str {
        match self {
            EventType::Register => "register",
            EventType::Delete => "delete",
            EventType::RegisterBlockedDid => "register_blocked_did",
            EventType::RegisterBlockedPds => "register_blocked_pds",
            EventType::RegisterBlockedKeyword => "register_blocked_keyword",
            EventType::AdminAssignReserved => "admin_assign_reserved",
            EventType::AdminDeleteAll => "admin_delete_all",
        }
    }
}

pub async fn log_event(
    pool: &SqlitePool,
    event_type: EventType,
    did: Option<&str>,
    sub: Option<&str>,
    pds_host: Option<&str>,
) -> AppResult<()> {
    log_event_with_cap(pool, ACTIVITY_LOG_CAP, event_type, did, sub, pds_host).await
}

/// Implementation separated so tests can verify pruning with a low cap
/// without inserting a thousand rows.
pub(crate) async fn log_event_with_cap(
    pool: &SqlitePool,
    cap: i64,
    event_type: EventType,
    did: Option<&str>,
    sub: Option<&str>,
    pds_host: Option<&str>,
) -> AppResult<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO activity_log (ts, event_type, did, sub, pds_host)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(now)
    .bind(event_type.as_str())
    .bind(did)
    .bind(sub)
    .bind(pds_host)
    .execute(&mut *tx)
    .await?;
    // Find the largest id we want to DROP: the (cap+1)th row from the
    // top. Everything <= that id goes. When the table is still under
    // `cap` rows, the subquery yields no row; COALESCE to 0 (ids start
    // at 1) turns the DELETE into a no-op.
    sqlx::query(
        "DELETE FROM activity_log WHERE id <= COALESCE(
             (SELECT id FROM activity_log ORDER BY id DESC LIMIT 1 OFFSET ?),
             0
         )",
    )
    .bind(cap)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn recent_activity(
    pool: &SqlitePool,
    limit: i64,
) -> AppResult<Vec<ActivityRow>> {
    Ok(sqlx::query_as(
        "SELECT id, ts, event_type, did, sub, pds_host
         FROM activity_log
         ORDER BY id DESC
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

// ==================================================================
// rate limit buckets (§3)
// ==================================================================

/// Increment (or create) the bucket for `key`, returning the new count.
/// `expires_at` is unix epoch seconds; we set it on create but leave it
/// alone on subsequent hits — the key itself encodes the time window
/// (e.g. `ip:1.2.3.4:register:hour:2026040620`), so the TTL is stable.
pub async fn bucket_incr(
    pool: &SqlitePool,
    key: &str,
    expires_at: i64,
) -> AppResult<i64> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO rate_limit_buckets (key, count, expires_at)
         VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = count + 1",
    )
    .bind(key)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    let count: i64 = sqlx::query_scalar("SELECT count FROM rate_limit_buckets WHERE key = ?")
        .bind(key)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(count)
}

pub async fn sweep_expired_buckets(pool: &SqlitePool, now_epoch: i64) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM rate_limit_buckets WHERE expires_at < ?")
        .bind(now_epoch)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

// ==================================================================
// admin: destructive imports
// ==================================================================

/// Wipe every config list and re-seed from `entries`. One transaction —
/// either the new config is live, or the old one still is.
pub async fn replace_all_config(
    pool: &SqlitePool,
    entries: &[(ConfigList, Vec<ConfigRow>)],
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for (list, _rows) in entries {
        let sql = format!("DELETE FROM {}", list.table());
        sqlx::query(&sql).execute(&mut *tx).await?;
    }
    for (list, rows) in entries {
        let sql = format!(
            "INSERT INTO {} (value, added_at, note) VALUES (?, ?, ?)",
            list.table()
        );
        for row in rows {
            sqlx::query(&sql)
                .bind(&row.value)
                .bind(&row.added_at)
                .bind(&row.note)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Wipe handles + DIDs and re-seed. The FK direction (handles → dids)
/// dictates insert order: DIDs first, then handles.
pub async fn replace_registry(
    pool: &SqlitePool,
    dids: &[DidRow],
    handles: &[HandleRow],
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM handles").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM dids").execute(&mut *tx).await?;
    for d in dids {
        sqlx::query("INSERT INTO dids (did, secret_hash, created_at) VALUES (?, ?, ?)")
            .bind(&d.did)
            .bind(&d.secret_hash)
            .bind(&d.created_at)
            .execute(&mut *tx)
            .await?;
    }
    for h in handles {
        sqlx::query("INSERT INTO handles (sub, did, created_at) VALUES (?, ?, ?)")
            .bind(&h.sub)
            .bind(&h.did)
            .bind(&h.created_at)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Full registry snapshot for export.
pub async fn dump_all_dids(pool: &SqlitePool) -> AppResult<Vec<DidRow>> {
    Ok(sqlx::query_as("SELECT did, secret_hash, created_at FROM dids ORDER BY did")
        .fetch_all(pool)
        .await?)
}

pub async fn dump_all_handles(pool: &SqlitePool) -> AppResult<Vec<HandleRow>> {
    Ok(sqlx::query_as("SELECT sub, did, created_at FROM handles ORDER BY sub")
        .fetch_all(pool)
        .await?)
}

// ==================================================================
// error classification
// ==================================================================

/// Detects SQLite UNIQUE / PRIMARY KEY constraint failures so service.rs
/// can translate duplicate-sub races into HandleUnavailable without
/// conflating them with real database errors. Extended codes:
///   2067 = SQLITE_CONSTRAINT_UNIQUE
///   1555 = SQLITE_CONSTRAINT_PRIMARYKEY
pub fn is_unique_violation(err: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db) = err {
        if let Some(code) = db.code() {
            return matches!(code.as_ref(), "2067" | "1555");
        }
    }
    false
}

// ==================================================================
// tests
// ==================================================================

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .journal_mode(SqliteJournalMode::Memory)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn migrations_apply_cleanly() {
        let _ = test_pool().await;
    }

    // --- handles + DIDs ---

    #[tokio::test]
    async fn register_roundtrip() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "hash1", "alice")
            .await
            .unwrap();
        let d = get_did(&pool, "did:plc:a").await.unwrap().unwrap();
        assert_eq!(d.secret_hash, "hash1");
        let h = get_handle_by_sub(&pool, "alice").await.unwrap().unwrap();
        assert_eq!(h.did, "did:plc:a");
        assert_eq!(count_handles_for_did(&pool, "did:plc:a").await.unwrap(), 1);
    }

    #[tokio::test]
    async fn second_handle_for_same_did() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        add_handle(&pool, "did:plc:a", "allie").await.unwrap();
        assert_eq!(
            list_handles_for_did(&pool, "did:plc:a").await.unwrap().len(),
            2
        );
    }

    #[tokio::test]
    async fn duplicate_sub_raises_unique_violation() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        let err = register_new_did_with_handle(&pool, "did:plc:b", "h", "alice")
            .await
            .expect_err("second registration must fail");
        match err {
            AppError::Database(e) => assert!(
                is_unique_violation(&e),
                "expected unique violation, got {e:?}"
            ),
            other => panic!("expected Database error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn delete_last_handle_drops_did() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        let r = delete_handle_and_maybe_did(&pool, "did:plc:a", "alice")
            .await
            .unwrap();
        assert_eq!(r, DeleteOutcome::Deleted { did_dropped: true });
        assert!(get_did(&pool, "did:plc:a").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_one_of_many_keeps_did() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        add_handle(&pool, "did:plc:a", "allie").await.unwrap();
        let r = delete_handle_and_maybe_did(&pool, "did:plc:a", "alice")
            .await
            .unwrap();
        assert_eq!(r, DeleteOutcome::Deleted { did_dropped: false });
        assert!(get_did(&pool, "did:plc:a").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn delete_not_owned_returns_notfound() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        let r = delete_handle_and_maybe_did(&pool, "did:plc:b", "alice")
            .await
            .unwrap();
        assert_eq!(r, DeleteOutcome::NotFound);
        assert!(get_handle_by_sub(&pool, "alice").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn admin_delete_did_cascades_handles() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        add_handle(&pool, "did:plc:a", "allie").await.unwrap();
        assert_eq!(delete_did_and_handles(&pool, "did:plc:a").await.unwrap(), 1);
        assert_eq!(count_handles_for_did(&pool, "did:plc:a").await.unwrap(), 0);
    }

    // --- config ---

    #[tokio::test]
    async fn config_add_contains_list_remove() {
        let pool = test_pool().await;
        assert!(
            !config_contains(&pool, ConfigList::BlockedDids, "did:plc:x")
                .await
                .unwrap()
        );
        config_add(&pool, ConfigList::BlockedDids, "did:plc:x", Some("spam"))
            .await
            .unwrap();
        assert!(
            config_contains(&pool, ConfigList::BlockedDids, "did:plc:x")
                .await
                .unwrap()
        );
        let all = config_list_all(&pool, ConfigList::BlockedDids).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].note.as_deref(), Some("spam"));
        assert!(
            config_remove(&pool, ConfigList::BlockedDids, "did:plc:x")
                .await
                .unwrap()
        );
        assert!(
            !config_contains(&pool, ConfigList::BlockedDids, "did:plc:x")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn config_add_updates_note_on_reinsert() {
        let pool = test_pool().await;
        config_add(&pool, ConfigList::VipDids, "did:plc:v", Some("old")).await.unwrap();
        config_add(&pool, ConfigList::VipDids, "did:plc:v", Some("new")).await.unwrap();
        let all = config_list_all(&pool, ConfigList::VipDids).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].note.as_deref(), Some("new"));
    }

    #[tokio::test]
    async fn blocked_keyword_substring_match() {
        let pool = test_pool().await;
        config_add(&pool, ConfigList::BlockedKeywords, "slur", None)
            .await
            .unwrap();
        assert!(handle_has_blocked_keyword(&pool, "myslurname").await.unwrap());
        assert!(handle_has_blocked_keyword(&pool, "slur").await.unwrap());
        assert!(!handle_has_blocked_keyword(&pool, "clean").await.unwrap());
    }

    #[tokio::test]
    async fn handles_matching_keyword_returns_registered_subs() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
            .await
            .unwrap();
        add_handle(&pool, "did:plc:a", "malice").await.unwrap();
        add_handle(&pool, "did:plc:a", "bob").await.unwrap();
        let hits = handles_matching_keyword(&pool, "lic").await.unwrap();
        assert_eq!(hits, vec!["alice".to_string(), "malice".to_string()]);
    }

    // --- activity log ---

    #[tokio::test]
    async fn activity_log_records_and_orders_newest_first() {
        let pool = test_pool().await;
        log_event(&pool, EventType::Register, Some("did:plc:a"), Some("alice"), None)
            .await
            .unwrap();
        log_event(&pool, EventType::Delete, Some("did:plc:a"), Some("alice"), None)
            .await
            .unwrap();
        let rows = recent_activity(&pool, 10).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].event_type, "delete");
        assert_eq!(rows[1].event_type, "register");
    }

    #[tokio::test]
    async fn activity_log_prunes_to_cap() {
        let pool = test_pool().await;
        // Exercise the prune logic with a small cap so the test is fast
        // but still covers the SQL path.
        for _ in 0..10 {
            log_event_with_cap(&pool, 3, EventType::Register, None, None, None)
                .await
                .unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 3);
    }

    // --- rate limit buckets ---

    #[tokio::test]
    async fn bucket_incr_counts_per_key() {
        let pool = test_pool().await;
        let exp = chrono::Utc::now().timestamp() + 3600;
        assert_eq!(bucket_incr(&pool, "a", exp).await.unwrap(), 1);
        assert_eq!(bucket_incr(&pool, "a", exp).await.unwrap(), 2);
        assert_eq!(bucket_incr(&pool, "a", exp).await.unwrap(), 3);
        assert_eq!(bucket_incr(&pool, "b", exp).await.unwrap(), 1);
    }

    // --- destructive imports ---

    #[tokio::test]
    async fn replace_all_config_wipes_and_reseeds() {
        let pool = test_pool().await;
        config_add(&pool, ConfigList::VipDids, "did:plc:old", None)
            .await
            .unwrap();
        config_add(&pool, ConfigList::BlockedDids, "did:plc:blocked_old", None)
            .await
            .unwrap();
        let new_rows = vec![(
            ConfigList::VipDids,
            vec![ConfigRow {
                value: "did:plc:new".into(),
                added_at: "2026-04-16T00:00:00Z".into(),
                note: Some("imported".into()),
            }],
        )];
        replace_all_config(&pool, &new_rows).await.unwrap();
        let vips = config_list_all(&pool, ConfigList::VipDids).await.unwrap();
        assert_eq!(vips.len(), 1);
        assert_eq!(vips[0].value, "did:plc:new");
        // Other lists — not passed in — were NOT wiped because replace
        // only touches the lists in `entries`. Verify:
        let blocked = config_list_all(&pool, ConfigList::BlockedDids)
            .await
            .unwrap();
        assert_eq!(blocked.len(), 1, "untouched lists remain");
    }

    #[tokio::test]
    async fn replace_registry_swaps_full_state() {
        let pool = test_pool().await;
        register_new_did_with_handle(&pool, "did:plc:old", "h", "alice")
            .await
            .unwrap();
        let new_dids = vec![DidRow {
            did: "did:plc:new".into(),
            secret_hash: "newhash".into(),
            created_at: "2026-04-16T00:00:00Z".into(),
        }];
        let new_handles = vec![HandleRow {
            sub: "newalice".into(),
            did: "did:plc:new".into(),
            created_at: "2026-04-16T00:00:00Z".into(),
        }];
        replace_registry(&pool, &new_dids, &new_handles).await.unwrap();
        assert!(get_did(&pool, "did:plc:old").await.unwrap().is_none());
        assert!(get_did(&pool, "did:plc:new").await.unwrap().is_some());
        assert!(get_handle_by_sub(&pool, "alice").await.unwrap().is_none());
        assert!(get_handle_by_sub(&pool, "newalice").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn sweep_removes_only_expired_buckets() {
        let pool = test_pool().await;
        bucket_incr(&pool, "old", 100).await.unwrap();
        bucket_incr(&pool, "fresh", 9_999_999_999).await.unwrap();
        let removed = sweep_expired_buckets(&pool, 1000).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(
            bucket_incr(&pool, "fresh", 9_999_999_999).await.unwrap(),
            2
        );
    }
}
