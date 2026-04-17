//! Rate-limit policy layer.
//!
//! The storage primitives live in `db::bucket_incr` / `sweep_expired_buckets`;
//! this module owns the policy: **which** buckets exist, **which** limits
//! apply, and the key format. The limits themselves are from DESIGN.md §7:
//!
//! | gate                  | window   | limit                |
//! |-----------------------|----------|----------------------|
//! | global per-IP         | 1 hour   | 100 ops              |
//! | register burst per-IP | 1 minute | 10 attempts          |
//! | register per-DID      | 1 hour   | 10 (60 for VIP)      |
//! | register per-PDS host | 1 hour   | 100                  |
//! | admin login per-IP    | 10 min   | 5 attempts           |
//!
//! §7 also mandates that "admin + trusted IPs bypass all rate limits".
//! That's a handler-level decision: the handler checks `is_trusted(ip)` or
//! the admin session flag and skips the whole gate stack. Individual gate
//! methods don't know about trusted IPs — they just count.
//!
//! Bucket keys follow the `§3` format: `{scope}:{id}:{op}:{window}:{stamp}`.
//! The `{stamp}` is a truncated-to-window timestamp so each window gets
//! its own fresh bucket, and old buckets become garbage-collectable as
//! soon as their `expires_at` passes.

use std::collections::HashSet;
use std::net::IpAddr;

use chrono::{DateTime, DurationRound, TimeDelta, Utc};
use sqlx::SqlitePool;

use crate::db;
use crate::error::AppResult;

// ------------------------------------------------------------------
// limits (§7)
// ------------------------------------------------------------------

const GLOBAL_PER_HOUR: i64 = 100;
const REGISTER_BURST_PER_MINUTE: i64 = 10;
const REGISTER_PER_DID_HOUR_NORMAL: i64 = 10;
const REGISTER_PER_DID_HOUR_VIP: i64 = 60;
const REGISTER_PER_PDS_HOUR: i64 = 100;
const ADMIN_LOGIN_PER_10MIN: i64 = 5;

// ------------------------------------------------------------------
// limiter
// ------------------------------------------------------------------

#[derive(Clone)]
pub struct RateLimiter {
    pool: SqlitePool,
    trusted_ips: HashSet<IpAddr>,
}

impl RateLimiter {
    pub fn new(pool: SqlitePool, trusted_ips: Vec<IpAddr>) -> Self {
        Self {
            pool,
            trusted_ips: trusted_ips.into_iter().collect(),
        }
    }

    /// §7: "admin + trusted IPs bypass all rate limits". Callers check
    /// this first and skip the gate stack entirely when true.
    pub fn is_trusted(&self, ip: IpAddr) -> bool {
        self.trusted_ips.contains(&ip)
    }

    // --- individual gates ---

    pub async fn allow_global(&self, ip: IpAddr) -> AppResult<bool> {
        let (stamp, expires) = hour_stamp(Utc::now());
        let key = format!("ip:{ip}:global:hour:{stamp}");
        check(&self.pool, &key, expires, GLOBAL_PER_HOUR).await
    }

    pub async fn allow_register_burst(&self, ip: IpAddr) -> AppResult<bool> {
        let (stamp, expires) = minute_stamp(Utc::now());
        let key = format!("ip:{ip}:register:min:{stamp}");
        check(&self.pool, &key, expires, REGISTER_BURST_PER_MINUTE).await
    }

    pub async fn allow_register_did(&self, did: &str, is_vip: bool) -> AppResult<bool> {
        let limit = if is_vip {
            REGISTER_PER_DID_HOUR_VIP
        } else {
            REGISTER_PER_DID_HOUR_NORMAL
        };
        let (stamp, expires) = hour_stamp(Utc::now());
        let key = format!("did:{did}:register:hour:{stamp}");
        check(&self.pool, &key, expires, limit).await
    }

    pub async fn allow_register_pds(&self, pds_host: &str) -> AppResult<bool> {
        let (stamp, expires) = hour_stamp(Utc::now());
        let key = format!("pds:{pds_host}:register:hour:{stamp}");
        check(&self.pool, &key, expires, REGISTER_PER_PDS_HOUR).await
    }

    pub async fn allow_admin_login(&self, ip: IpAddr) -> AppResult<bool> {
        let (stamp, expires) = ten_minute_stamp(Utc::now());
        let key = format!("ip:{ip}:admin_login:10min:{stamp}");
        check(&self.pool, &key, expires, ADMIN_LOGIN_PER_10MIN).await
    }

    /// Delete buckets whose `expires_at` has passed. Call periodically
    /// from a background task — the table grows one row per active
    /// {scope, id, window} tuple and reclaims space only when swept.
    pub async fn sweep(&self) -> AppResult<u64> {
        db::sweep_expired_buckets(&self.pool, Utc::now().timestamp()).await
    }
}

// ------------------------------------------------------------------
// gate plumbing
// ------------------------------------------------------------------

/// Increment the bucket and compare its new count to the policy limit.
/// `true` = allow (under or at the limit); `false` = deny.
///
/// Note on ordering: we increment *before* checking, so the nth call
/// that sees `count == limit` is the last one we allow. The (n+1)th
/// sees `count > limit` and denies. This makes the counter-visible
/// value honest for ops who read the table directly.
async fn check(
    pool: &SqlitePool,
    key: &str,
    expires_at: i64,
    limit: i64,
) -> AppResult<bool> {
    let count = db::bucket_incr(pool, key, expires_at).await?;
    Ok(count <= limit)
}

// ------------------------------------------------------------------
// window key builders
// ------------------------------------------------------------------

/// Truncate `now` to the start of its one-hour window and return
/// `(stamp, expires_at)` where expires_at = start-of-next-hour.
/// Stamp format `YYYYMMDDHH` matches the example in §3.
fn hour_stamp(now: DateTime<Utc>) -> (String, i64) {
    let start = now
        .duration_trunc(TimeDelta::hours(1))
        .expect("hour-trunc is lossless");
    let end = start + TimeDelta::hours(1);
    (start.format("%Y%m%d%H").to_string(), end.timestamp())
}

fn minute_stamp(now: DateTime<Utc>) -> (String, i64) {
    let start = now
        .duration_trunc(TimeDelta::minutes(1))
        .expect("minute-trunc is lossless");
    let end = start + TimeDelta::minutes(1);
    (start.format("%Y%m%d%H%M").to_string(), end.timestamp())
}

fn ten_minute_stamp(now: DateTime<Utc>) -> (String, i64) {
    let start = now
        .duration_trunc(TimeDelta::minutes(10))
        .expect("10min-trunc is lossless");
    let end = start + TimeDelta::minutes(10);
    (start.format("%Y%m%d%H%M").to_string(), end.timestamp())
}

// ------------------------------------------------------------------
// tests
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

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

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[tokio::test]
    async fn global_ip_allows_up_to_limit_then_denies() {
        let rl = RateLimiter::new(test_pool().await, vec![]);
        let me = ip("1.2.3.4");
        for i in 1..=GLOBAL_PER_HOUR {
            assert!(rl.allow_global(me).await.unwrap(), "call {i} allowed");
        }
        assert!(!rl.allow_global(me).await.unwrap(), "over limit denies");
    }

    #[tokio::test]
    async fn register_burst_is_per_minute_per_ip() {
        let rl = RateLimiter::new(test_pool().await, vec![]);
        let a = ip("1.1.1.1");
        let b = ip("2.2.2.2");
        for _ in 0..REGISTER_BURST_PER_MINUTE {
            assert!(rl.allow_register_burst(a).await.unwrap());
        }
        assert!(!rl.allow_register_burst(a).await.unwrap());
        // Different IP has its own bucket.
        assert!(rl.allow_register_burst(b).await.unwrap());
    }

    #[tokio::test]
    async fn register_per_did_vip_has_higher_cap() {
        let rl = RateLimiter::new(test_pool().await, vec![]);
        // Normal DID caps at 10/hour.
        for _ in 0..REGISTER_PER_DID_HOUR_NORMAL {
            assert!(rl.allow_register_did("did:plc:normal", false).await.unwrap());
        }
        assert!(!rl.allow_register_did("did:plc:normal", false).await.unwrap());
        // VIP DID continues under its own key (different is_vip shouldn't
        // matter for bucket identity — but we're exercising a fresh DID).
        for _ in 0..REGISTER_PER_DID_HOUR_VIP {
            assert!(rl.allow_register_did("did:plc:vip", true).await.unwrap());
        }
        assert!(!rl.allow_register_did("did:plc:vip", true).await.unwrap());
    }

    #[tokio::test]
    async fn register_per_pds_is_isolated_per_host() {
        let rl = RateLimiter::new(test_pool().await, vec![]);
        for _ in 0..REGISTER_PER_PDS_HOUR {
            assert!(rl.allow_register_pds("bsky.social").await.unwrap());
        }
        assert!(!rl.allow_register_pds("bsky.social").await.unwrap());
        assert!(rl.allow_register_pds("other.pds").await.unwrap());
    }

    #[tokio::test]
    async fn admin_login_caps_at_5_per_10min_per_ip() {
        let rl = RateLimiter::new(test_pool().await, vec![]);
        let attacker = ip("9.9.9.9");
        for _ in 0..ADMIN_LOGIN_PER_10MIN {
            assert!(rl.allow_admin_login(attacker).await.unwrap());
        }
        assert!(!rl.allow_admin_login(attacker).await.unwrap());
    }

    #[tokio::test]
    async fn trusted_ip_lookup_is_independent_of_gates() {
        let trusted = ip("10.0.0.1");
        let rl = RateLimiter::new(test_pool().await, vec![trusted]);
        assert!(rl.is_trusted(trusted));
        assert!(!rl.is_trusted(ip("10.0.0.2")));
        // is_trusted doesn't touch the bucket — gates still count if
        // the caller chooses to invoke them.
        for _ in 0..REGISTER_BURST_PER_MINUTE {
            assert!(rl.allow_register_burst(trusted).await.unwrap());
        }
        assert!(!rl.allow_register_burst(trusted).await.unwrap());
    }

    #[tokio::test]
    async fn sweep_clears_only_expired_buckets() {
        let pool = test_pool().await;
        let rl = RateLimiter::new(pool.clone(), vec![]);
        // Record one real bucket via the gate (expires within this hour).
        let _ = rl.allow_global(ip("1.1.1.1")).await.unwrap();
        // And one synthetic expired one directly.
        db::bucket_incr(&pool, "stale:bucket", 100).await.unwrap();
        let removed = rl.sweep().await.unwrap();
        assert_eq!(removed, 1);
    }

    // --- stamp format ---

    #[tokio::test]
    async fn stamp_format_matches_design_example() {
        // §3 shows `ip:1.2.3.4:register:hour:2026040620` — the stamp is
        // the 10-char YYYYMMDDHH form.
        let t = chrono::DateTime::parse_from_rfc3339("2026-04-06T20:34:12Z")
            .unwrap()
            .with_timezone(&Utc);
        let (stamp, _) = hour_stamp(t);
        assert_eq!(stamp, "2026040620");
    }

    #[tokio::test]
    async fn ten_minute_stamp_truncates_to_10min_boundary() {
        let t = chrono::DateTime::parse_from_rfc3339("2026-04-06T20:37:12Z")
            .unwrap()
            .with_timezone(&Utc);
        let (stamp, expires) = ten_minute_stamp(t);
        // Start of the window is 20:30:00.
        assert_eq!(stamp, "202604062030");
        // Expiry is 20:40:00.
        let expected_end = chrono::DateTime::parse_from_rfc3339("2026-04-06T20:40:00Z")
            .unwrap()
            .timestamp();
        assert_eq!(expires, expected_end);
    }
}
