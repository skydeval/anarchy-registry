//! Business logic — the layer DESIGN.md §4.6 describes as having "no http
//! or sql awareness".
//!
//! Handlers call into `Service` to perform the three user-facing flows
//! (register, list, delete) and the `.well-known/atproto-did` resolve.
//! The service composes:
//!
//! - `validate` for input normalization + shape checks
//! - `atproto` for external handle/PDS lookups
//! - `rate_limit` for per-IP / per-DID / per-PDS gates
//! - `db` for storage primitives
//! - `auth` for secret generation + hashing
//!
//! The ordering inside `register` is deliberate: local checks first, then
//! IP-level rate limits (so attackers flooding us with junk can't burn
//! upstream PLC / appview quotas), then resolution, then blocklists + the
//! remaining gates, then state checks, then the transactional write. Each
//! "you can't have this" outcome either logs a specific event
//! (`register_blocked_did`, `register_blocked_pds`, `register_blocked_keyword`)
//! for operator visibility or returns the unified §4.3 `HandleUnavailable`
//! message to the user.

use std::net::IpAddr;

use serde::Serialize;
use sqlx::SqlitePool;
use tracing::{info, warn};

use crate::atproto::AtprotoClient;
use crate::auth;
use crate::db::{self, ConfigList, DeleteOutcome, EventType};
use crate::error::{AppError, AppResult};
use crate::rate_limit::RateLimiter;
use crate::validate;

/// Per-DID handle cap for non-VIP DIDs (§7). VIPs are unlimited.
const HANDLE_LIMIT_PER_DID: i64 = 5;

// ------------------------------------------------------------------
// resolver trait — lets tests inject a mock without spinning up HTTP
// ------------------------------------------------------------------

pub trait HandleResolver: Send + Sync {
    fn resolve_handle(
        &self,
        handle: &str,
    ) -> impl std::future::Future<Output = Option<String>> + Send;

    fn resolve_pds_host(
        &self,
        did: &str,
    ) -> impl std::future::Future<Output = Option<String>> + Send;
}

impl HandleResolver for AtprotoClient {
    async fn resolve_handle(&self, handle: &str) -> Option<String> {
        AtprotoClient::resolve_handle(self, handle).await
    }
    async fn resolve_pds_host(&self, did: &str) -> Option<String> {
        AtprotoClient::resolve_pds_host(self, did).await
    }
}

// ------------------------------------------------------------------
// service
// ------------------------------------------------------------------

pub struct Service<R: HandleResolver> {
    pool: SqlitePool,
    resolver: R,
    rate_limiter: RateLimiter,
    /// `anarchy.lgbt`. Used to render the full handle string
    /// (`{sub}.{base_domain}`) back in responses.
    base_domain: String,
}

// ------------------------------------------------------------------
// result types mirroring the DESIGN §5 response shapes
// ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RegisterResult {
    pub did: String,
    pub handle: String,
    /// Present only on the user's first registration for a DID; `None`
    /// when adding a second handle to an existing DID (§5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListResult {
    pub did: String,
    pub handles: Vec<ListedHandle>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListedHandle {
    pub sub: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteResult {
    pub did: String,
    pub deleted: String,
}

// ------------------------------------------------------------------
// impl
// ------------------------------------------------------------------

impl<R: HandleResolver> Service<R> {
    pub fn new(
        pool: SqlitePool,
        resolver: R,
        rate_limiter: RateLimiter,
        base_domain: String,
    ) -> Self {
        Self { pool, resolver, rate_limiter, base_domain }
    }

    /// Read-only access to the backing pool, for admin handlers that
    /// query outside the user-facing flows (the scope of §5 admin
    /// read-outs — DID lists, activity log, exports).
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// Admin surface: resolve a bluesky handle via the same upstream
    /// the register flow uses. §5: `POST {ADMIN_PATH}/resolve`.
    pub async fn admin_resolve_handle(&self, handle: &str) -> Option<String> {
        self.resolver.resolve_handle(handle).await
    }

    /// Admin surface: assign a handle to a DID, bypassing the normal
    /// claim flow (no bsky resolution, no blocklist checks, no rate
    /// limits — admin already vetted this).
    ///
    /// §5: "generates new secret if DID is new". Returns the plaintext
    /// secret only on first-claim, so the operator can pass it to the
    /// user out-of-band.
    pub async fn admin_assign_handle(
        &self,
        did: &str,
        sub: &str,
    ) -> AppResult<RegisterResult> {
        let did = validate::normalize_did(did);
        if !validate::is_valid_did(&did) {
            return Err(AppError::InvalidHandleFormat);
        }
        let sub = validate::normalize_subdomain(sub);
        if !validate::is_valid_subdomain(&sub) {
            return Err(AppError::InvalidHandleFormat);
        }
        if db::get_handle_by_sub(&self.pool, &sub).await?.is_some() {
            return Err(AppError::HandleUnavailable);
        }

        let existing = db::get_did(&self.pool, &did).await?;
        let is_new = existing.is_none();
        let secret_plain = if is_new {
            let plain = auth::generate_user_secret();
            let hash = auth::hash_user_secret(&plain);
            db::register_new_did_with_handle(&self.pool, &did, &hash, &sub)
                .await
                .map_err(race_to_unavailable)?;
            Some(plain)
        } else {
            db::add_handle(&self.pool, &did, &sub)
                .await
                .map_err(race_to_unavailable)?;
            None
        };

        db::log_event(
            &self.pool,
            EventType::AdminAssignReserved,
            Some(&did),
            Some(&sub),
            None,
        )
        .await?;
        info!(did = %did, sub = %sub, new_did = is_new, "admin assign-handle");

        Ok(RegisterResult {
            did,
            handle: self.format_handle(&sub),
            secret_key: secret_plain,
        })
    }

    // --------------------------------------------------------------
    // /register
    // --------------------------------------------------------------

    pub async fn register(
        &self,
        bsky_handle: &str,
        subdomain: &str,
        client_ip: IpAddr,
    ) -> AppResult<RegisterResult> {
        // 1. Local validation. Cheap, reject the obvious junk before
        //    we spend any other resource on it.
        let sub = validate::normalize_subdomain(subdomain);
        if !validate::is_valid_subdomain(&sub) {
            return Err(AppError::InvalidHandleFormat);
        }

        // 2. IP rate limits *before* network calls so attackers can't
        //    force us to burn upstream PLC/appview budget.
        let trusted = self.rate_limiter.is_trusted(client_ip);
        if !trusted {
            if !self.rate_limiter.allow_global(client_ip).await? {
                return Err(AppError::NotFound);
            }
            if !self.rate_limiter.allow_register_burst(client_ip).await? {
                return Err(AppError::NotFound);
            }
        }

        // 3. Resolve the bsky handle to a DID.
        let did = match self.resolver.resolve_handle(bsky_handle).await {
            Some(d) => validate::normalize_did(&d),
            None => return Err(AppError::UnresolvableBlueskyHandle),
        };
        if !validate::is_valid_did(&did) {
            return Err(AppError::UnresolvableBlueskyHandle);
        }

        // 4. DID blocklist (§3 event: register_blocked_did).
        if db::config_contains(&self.pool, ConfigList::BlockedDids, &did).await? {
            db::log_event(
                &self.pool,
                EventType::RegisterBlockedDid,
                Some(&did),
                Some(&sub),
                None,
            )
            .await?;
            warn!(did = %did, sub = %sub, "register rejected: blocked DID");
            return Err(AppError::HandleUnavailable);
        }

        // 5. PDS blocklist. PLC lookup is best-effort — if we can't
        //    resolve the PDS we proceed without a blocklist check
        //    rather than blocking legitimate users behind PLC outages.
        let pds_host = self.resolver.resolve_pds_host(&did).await;
        if let Some(host) = &pds_host {
            if db::config_contains(&self.pool, ConfigList::BlockedPds, host).await? {
                db::log_event(
                    &self.pool,
                    EventType::RegisterBlockedPds,
                    Some(&did),
                    Some(&sub),
                    Some(host),
                )
                .await?;
                warn!(did = %did, sub = %sub, pds = %host, "register rejected: blocked PDS");
                return Err(AppError::HandleUnavailable);
            }
        }

        // 6. Post-resolution rate gates, skipped for trusted IPs (§7).
        if !trusted {
            if !self.rate_limiter.allow_register_did(&did, is_vip(&self.pool, &did).await?).await?
            {
                return Err(AppError::NotFound);
            }
            if let Some(host) = &pds_host {
                if !self.rate_limiter.allow_register_pds(host).await? {
                    return Err(AppError::NotFound);
                }
            }
        }

        // 7. Sub availability: reserved, keyword-blocked, or already
        //    taken all collapse to HandleUnavailable (§4.3). Keyword
        //    blocks are logged so the operator can spot patterns.
        if db::config_contains(&self.pool, ConfigList::ReservedHandles, &sub).await? {
            return Err(AppError::HandleUnavailable);
        }
        if db::handle_has_blocked_keyword(&self.pool, &sub).await? {
            db::log_event(
                &self.pool,
                EventType::RegisterBlockedKeyword,
                Some(&did),
                Some(&sub),
                pds_host.as_deref(),
            )
            .await?;
            return Err(AppError::HandleUnavailable);
        }
        if db::get_handle_by_sub(&self.pool, &sub).await?.is_some() {
            return Err(AppError::HandleUnavailable);
        }

        // 8. Handle cap: 5 for normal, unlimited for VIP (§7).
        let existing = db::get_did(&self.pool, &did).await?;
        let is_new_did = existing.is_none();
        if let Some(_row) = &existing {
            let count = db::count_handles_for_did(&self.pool, &did).await?;
            if !is_vip(&self.pool, &did).await? && count >= HANDLE_LIMIT_PER_DID {
                return Err(AppError::HandleLimitReached);
            }
        }

        // 9. Write.
        let (secret_plain, secret_hash) = if is_new_did {
            let plain = auth::generate_user_secret();
            let hashed = auth::hash_user_secret(&plain);
            (Some(plain), Some(hashed))
        } else {
            (None, None)
        };

        if is_new_did {
            let hash = secret_hash.as_deref().expect("new DID always has a secret");
            db::register_new_did_with_handle(&self.pool, &did, hash, &sub)
                .await
                .map_err(race_to_unavailable)?;
        } else {
            db::add_handle(&self.pool, &did, &sub)
                .await
                .map_err(race_to_unavailable)?;
        }

        // 10. Log success and return.
        db::log_event(
            &self.pool,
            EventType::Register,
            Some(&did),
            Some(&sub),
            pds_host.as_deref(),
        )
        .await?;
        info!(did = %did, sub = %sub, new_did = is_new_did, "registered");

        Ok(RegisterResult {
            did,
            handle: self.format_handle(&sub),
            secret_key: secret_plain,
        })
    }

    // --------------------------------------------------------------
    // /manage list
    // --------------------------------------------------------------

    pub async fn list_handles(
        &self,
        secret: &str,
        client_ip: IpAddr,
    ) -> AppResult<ListResult> {
        if !self.rate_limiter.is_trusted(client_ip)
            && !self.rate_limiter.allow_global(client_ip).await?
        {
            return Err(AppError::NotFound);
        }
        let did_row = self.find_did_for_secret(secret).await?;
        let handles = db::list_handles_for_did(&self.pool, &did_row.did).await?;
        Ok(ListResult {
            did: did_row.did,
            handles: handles
                .into_iter()
                .map(|h| ListedHandle { sub: h.sub, created_at: h.created_at })
                .collect(),
        })
    }

    // --------------------------------------------------------------
    // /manage delete
    // --------------------------------------------------------------

    pub async fn delete_handle(
        &self,
        secret: &str,
        sub: &str,
        client_ip: IpAddr,
    ) -> AppResult<DeleteResult> {
        if !self.rate_limiter.is_trusted(client_ip)
            && !self.rate_limiter.allow_global(client_ip).await?
        {
            return Err(AppError::NotFound);
        }
        let sub = validate::normalize_subdomain(sub);
        if !validate::is_valid_subdomain(&sub) {
            // Can't be one of this user's handles — shape is enforced
            // at registration, so bad-shape subs are always "not yours".
            return Err(AppError::SecretDoesNotControlHandle);
        }
        let did_row = self.find_did_for_secret(secret).await?;

        match db::delete_handle_and_maybe_did(&self.pool, &did_row.did, &sub).await? {
            DeleteOutcome::NotFound => Err(AppError::SecretDoesNotControlHandle),
            DeleteOutcome::Deleted { did_dropped: _ } => {
                db::log_event(
                    &self.pool,
                    EventType::Delete,
                    Some(&did_row.did),
                    Some(&sub),
                    None,
                )
                .await?;
                info!(did = %did_row.did, sub = %sub, "deleted");
                Ok(DeleteResult {
                    did: did_row.did,
                    deleted: self.format_handle(&sub),
                })
            }
        }
    }

    // --------------------------------------------------------------
    // /.well-known/atproto-did
    // --------------------------------------------------------------

    /// §5: success returns the DID as plain text; every failure mode
    /// is an identical `404 not found` (§4.3). We map through `NotFound`.
    pub async fn resolve_sub_to_did(&self, sub: &str) -> AppResult<String> {
        let sub = validate::normalize_subdomain(sub);
        if !validate::is_valid_subdomain(&sub) {
            return Err(AppError::NotFound);
        }
        match db::get_handle_by_sub(&self.pool, &sub).await? {
            Some(h) => Ok(h.did),
            None => Err(AppError::NotFound),
        }
    }

    // --------------------------------------------------------------
    // helpers
    // --------------------------------------------------------------

    fn format_handle(&self, sub: &str) -> String {
        format!("{sub}.{base}", base = self.base_domain)
    }

    /// Hash the submitted secret, look up by hash. The lookup via the
    /// unique index on `dids.secret_hash` is constant-time relative to
    /// the input at the DB level; the prior `hash_user_secret` call is
    /// also independent of any stored value. Either way, "wrong secret"
    /// and "no such user" produce the same error message (§7).
    async fn find_did_for_secret(&self, secret: &str) -> AppResult<db::DidRow> {
        let hashed = auth::hash_user_secret(secret);
        match db::find_did_by_secret_hash(&self.pool, &hashed).await? {
            Some(row) => Ok(row),
            None => Err(AppError::InvalidSecret),
        }
    }
}

// ------------------------------------------------------------------
// free helpers
// ------------------------------------------------------------------

async fn is_vip(pool: &SqlitePool, did: &str) -> AppResult<bool> {
    db::config_contains(pool, ConfigList::VipDids, did).await
}

/// A duplicate-sub race — another tx committed our chosen sub between
/// our existence check and our insert. Map the unique violation to
/// `HandleUnavailable` so the user sees the same message as if they'd
/// queried a moment later.
fn race_to_unavailable(err: AppError) -> AppError {
    if let AppError::Database(e) = &err {
        if db::is_unique_violation(e) {
            return AppError::HandleUnavailable;
        }
    }
    err
}

// ==================================================================
// tests
// ==================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::sync::Mutex;

    // --- test harness ---

    struct MockResolver {
        // stub returns keyed by handle / did. Mutex gives interior
        // mutability so tests can seed before calling Service methods.
        handles: Mutex<std::collections::HashMap<String, Option<String>>>,
        pds: Mutex<std::collections::HashMap<String, Option<String>>>,
    }

    impl MockResolver {
        fn new() -> Self {
            Self {
                handles: Mutex::new(Default::default()),
                pds: Mutex::new(Default::default()),
            }
        }
        fn set_handle(&self, handle: &str, did: Option<&str>) {
            self.handles
                .lock()
                .unwrap()
                .insert(handle.to_string(), did.map(str::to_string));
        }
        fn set_pds(&self, did: &str, host: Option<&str>) {
            self.pds
                .lock()
                .unwrap()
                .insert(did.to_string(), host.map(str::to_string));
        }
    }

    impl HandleResolver for MockResolver {
        async fn resolve_handle(&self, handle: &str) -> Option<String> {
            self.handles.lock().unwrap().get(handle).cloned().unwrap_or(None)
        }
        async fn resolve_pds_host(&self, did: &str) -> Option<String> {
            self.pds.lock().unwrap().get(did).cloned().unwrap_or(None)
        }
    }

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

    async fn setup() -> (Service<MockResolver>, SqlitePool) {
        let pool = test_pool().await;
        let resolver = MockResolver::new();
        let rl = RateLimiter::new(pool.clone(), vec![]);
        let svc = Service::new(pool.clone(), resolver, rl, "anarchy.lgbt".into());
        (svc, pool)
    }

    fn ip() -> IpAddr {
        "1.2.3.4".parse().unwrap()
    }

    // --- register ---

    #[tokio::test]
    async fn register_rejects_invalid_subdomain() {
        let (svc, _) = setup().await;
        let err = svc.register("alice.bsky.social", "a-", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidHandleFormat));
    }

    #[tokio::test]
    async fn register_rejects_unresolvable_handle() {
        let (svc, _) = setup().await;
        // resolver has no mapping → returns None.
        let err = svc.register("nobody.bsky.social", "alice", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::UnresolvableBlueskyHandle));
    }

    #[tokio::test]
    async fn register_first_claim_returns_secret() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("alice.bsky.social", Some("did:plc:alice"));
        let r = svc
            .register("alice.bsky.social", "alice", ip())
            .await
            .unwrap();
        assert_eq!(r.did, "did:plc:alice");
        assert_eq!(r.handle, "alice.anarchy.lgbt");
        assert!(r.secret_key.is_some());
        // Stored.
        assert!(db::get_did(&pool, "did:plc:alice").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn register_second_handle_no_new_secret() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("alice.bsky.social", Some("did:plc:alice"));
        let _ = svc.register("alice.bsky.social", "alice", ip()).await.unwrap();
        let r = svc.register("alice.bsky.social", "allie", ip()).await.unwrap();
        assert!(r.secret_key.is_none());
    }

    #[tokio::test]
    async fn register_blocked_did_returns_unavailable_and_logs() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("bad.bsky.social", Some("did:plc:bad"));
        db::config_add(&pool, ConfigList::BlockedDids, "did:plc:bad", None)
            .await
            .unwrap();
        let err = svc.register("bad.bsky.social", "alice", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::HandleUnavailable));
        let events = db::recent_activity(&pool, 10).await.unwrap();
        assert!(events.iter().any(|e| e.event_type == "register_blocked_did"));
    }

    #[tokio::test]
    async fn register_blocked_pds_returns_unavailable_and_logs() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("x.bsky.social", Some("did:plc:x"));
        svc.resolver.set_pds("did:plc:x", Some("evil.pds"));
        db::config_add(&pool, ConfigList::BlockedPds, "evil.pds", None)
            .await
            .unwrap();
        let err = svc.register("x.bsky.social", "alice", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::HandleUnavailable));
        let events = db::recent_activity(&pool, 10).await.unwrap();
        assert!(events.iter().any(|e| e.event_type == "register_blocked_pds"));
    }

    #[tokio::test]
    async fn register_reserved_handle_is_unavailable() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("alice.bsky.social", Some("did:plc:a"));
        db::config_add(&pool, ConfigList::ReservedHandles, "admin", None)
            .await
            .unwrap();
        let err = svc.register("alice.bsky.social", "admin", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::HandleUnavailable));
    }

    #[tokio::test]
    async fn register_blocked_keyword_is_unavailable_and_logs() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("alice.bsky.social", Some("did:plc:a"));
        db::config_add(&pool, ConfigList::BlockedKeywords, "slur", None)
            .await
            .unwrap();
        let err = svc.register("alice.bsky.social", "myslurname", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::HandleUnavailable));
        let events = db::recent_activity(&pool, 10).await.unwrap();
        assert!(events.iter().any(|e| e.event_type == "register_blocked_keyword"));
    }

    #[tokio::test]
    async fn register_taken_sub_is_unavailable() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        svc.resolver.set_handle("b.bsky.social", Some("did:plc:b"));
        svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let err = svc.register("b.bsky.social", "alice", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::HandleUnavailable));
    }

    #[tokio::test]
    async fn register_handle_limit_enforced_for_normal_did() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        for sub in ["one1", "two2", "three3", "four4", "five5"] {
            svc.register("a.bsky.social", sub, ip()).await.unwrap();
        }
        let err = svc.register("a.bsky.social", "six6", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::HandleLimitReached));
    }

    #[tokio::test]
    async fn register_handle_limit_bypassed_for_vip() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("vip.bsky.social", Some("did:plc:vip"));
        db::config_add(&pool, ConfigList::VipDids, "did:plc:vip", None)
            .await
            .unwrap();
        for sub in ["one1", "two2", "three3", "four4", "five5", "six6"] {
            svc.register("vip.bsky.social", sub, ip()).await.unwrap();
        }
    }

    // --- manage ---

    #[tokio::test]
    async fn list_handles_returns_for_owner() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        let r = svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let secret = r.secret_key.unwrap();
        let listed = svc.list_handles(&secret, ip()).await.unwrap();
        assert_eq!(listed.did, "did:plc:a");
        assert_eq!(listed.handles.len(), 1);
        assert_eq!(listed.handles[0].sub, "alice");
    }

    #[tokio::test]
    async fn list_handles_wrong_secret_is_invalid() {
        let (svc, _) = setup().await;
        let err = svc.list_handles("not-a-real-secret", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidSecret));
    }

    #[tokio::test]
    async fn delete_handle_by_owner() {
        let (svc, pool) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        let r = svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let secret = r.secret_key.unwrap();
        let d = svc.delete_handle(&secret, "alice", ip()).await.unwrap();
        assert_eq!(d.deleted, "alice.anarchy.lgbt");
        assert!(db::get_handle_by_sub(&pool, "alice").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_handle_wrong_sub_rejected() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        let r = svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let secret = r.secret_key.unwrap();
        let err = svc.delete_handle(&secret, "bob", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::SecretDoesNotControlHandle));
    }

    #[tokio::test]
    async fn delete_handle_wrong_secret_rejected() {
        let (svc, _) = setup().await;
        let err = svc.delete_handle("nope", "alice", ip()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidSecret));
    }

    // --- resolve ---

    #[tokio::test]
    async fn resolve_sub_to_did_returns_did_for_existing() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let did = svc.resolve_sub_to_did("alice").await.unwrap();
        assert_eq!(did, "did:plc:a");
    }

    #[tokio::test]
    async fn resolve_sub_to_did_missing_is_notfound() {
        let (svc, _) = setup().await;
        let err = svc.resolve_sub_to_did("nobody").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound));
    }

    #[tokio::test]
    async fn resolve_sub_to_did_invalid_is_notfound() {
        let (svc, _) = setup().await;
        let err = svc.resolve_sub_to_did("x--y").await.unwrap_err();
        assert!(matches!(err, AppError::NotFound));
    }

    // --- admin service ops ---

    #[tokio::test]
    async fn admin_assign_handle_generates_secret_for_new_did() {
        let (svc, _) = setup().await;
        let r = svc
            .admin_assign_handle("did:plc:new", "reserved1")
            .await
            .unwrap();
        assert_eq!(r.did, "did:plc:new");
        assert_eq!(r.handle, "reserved1.anarchy.lgbt");
        assert!(r.secret_key.is_some());
    }

    #[tokio::test]
    async fn admin_assign_handle_no_secret_for_existing_did() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let r = svc.admin_assign_handle("did:plc:a", "allie").await.unwrap();
        assert!(r.secret_key.is_none());
    }

    #[tokio::test]
    async fn admin_assign_handle_rejects_bad_did() {
        let (svc, _) = setup().await;
        let err = svc
            .admin_assign_handle("not-a-did", "reserved1")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidHandleFormat));
    }

    #[tokio::test]
    async fn admin_assign_handle_rejects_taken_sub() {
        let (svc, _) = setup().await;
        svc.resolver.set_handle("a.bsky.social", Some("did:plc:a"));
        svc.register("a.bsky.social", "alice", ip()).await.unwrap();
        let err = svc
            .admin_assign_handle("did:plc:other", "alice")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::HandleUnavailable));
    }
}
