//! Admin HTTP surface (DESIGN.md §4.4, §5).
//!
//! The non-enumeration rule is load-bearing here: **every** unauthenticated
//! request to `{ADMIN_PATH}/*` collapses to a `404 not found`, including
//! wrong-password logins, rate-limited login attempts, and missing-CSRF
//! POSTs. From a scanner's perspective the admin surface is
//! indistinguishable from a missing path.
//!
//! All admin POST endpoints require a valid CSRF token (§4.4,§5) supplied
//! as an `X-CSRF-Token` header. The token is issued in the login response
//! body; the admin console stashes it and replays it on subsequent POSTs.

use std::collections::HashMap;

use axum::{
    Json,
    extract::{FromRequestParts, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, Session};
use crate::db::{self, ConfigList, ConfigRow, DidRow, EventType, HandleRow};
use crate::error::{AppError, AppResult};
use crate::validate;

use super::{AppState, ClientIp, clear_cookie, read_cookie, session_cookie};

pub const SESSION_COOKIE: &str = "anarchy_session";
const CSRF_HEADER: &str = "x-csrf-token";

// ==================================================================
// extractors: session + CSRF
// ==================================================================

/// Extractor that requires a valid admin session. Rejects with
/// `AppError::NotFound` — the non-enumeration collapse from §4.3 — on
/// any missing/invalid/expired session.
pub struct RequireAdmin(pub Session);

impl FromRequestParts<AppState> for RequireAdmin {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let cookie = read_cookie(&parts.headers, SESSION_COOKIE).ok_or(AppError::NotFound)?;
        let session = auth::parse_session(&state.admin.session_secret, &cookie)
            .ok_or(AppError::NotFound)?;
        Ok(RequireAdmin(session))
    }
}

/// Extractor that proves the request carries a matching CSRF token
/// (§4.4). Always extracted *together with* `RequireAdmin` on POST
/// endpoints — the two checks are independent by design.
pub struct CsrfOk;

impl FromRequestParts<AppState> for CsrfOk {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let cookie = read_cookie(&parts.headers, SESSION_COOKIE).ok_or(AppError::NotFound)?;
        let session = auth::parse_session(&state.admin.session_secret, &cookie)
            .ok_or(AppError::NotFound)?;
        let header_val = parts
            .headers
            .get(CSRF_HEADER)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::NotFound)?;
        if !auth::verify_csrf(&state.admin.session_secret, &session, header_val) {
            return Err(AppError::NotFound);
        }
        Ok(CsrfOk)
    }
}

// ==================================================================
// POST {ADMIN_PATH} — login
// ==================================================================

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<LoginRequest>,
) -> AppResult<Response> {
    if !state.rate_limiter.is_trusted(ip)
        && !state.rate_limiter.allow_admin_login(ip).await?
    {
        return Err(AppError::NotFound);
    }
    if !auth::verify_admin_password(&req.password, &state.admin.password_hash) {
        return Err(AppError::NotFound);
    }

    let (session, cookie_value) =
        auth::issue_session(&state.admin.session_secret, state.admin.session_ttl_seconds);
    let csrf = auth::csrf_token_for(&state.admin.session_secret, &session);

    let body = Json(json!({ "ok": true, "csrf_token": csrf }));
    let mut resp = body.into_response();
    resp.headers_mut().append(
        header::SET_COOKIE,
        session_cookie(
            SESSION_COOKIE,
            &cookie_value,
            state.admin.session_ttl_seconds,
        ),
    );
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// GET {ADMIN_PATH} — console page (placeholder)
// ==================================================================

/// Embedded admin SPA (§11). Two placeholders — `{{CSRF_TOKEN}}` and
/// `{{ADMIN_PATH}}` — are substituted server-side before the page hits
/// the network, so the SPA can pin its CSRF header and build API URLs
/// without a bootstrap round-trip.
const ADMIN_HTML: &str = include_str!("../../static/admin.html");

pub async fn console(
    RequireAdmin(session): RequireAdmin,
    State(state): State<AppState>,
) -> Response {
    let csrf = auth::csrf_token_for(&state.admin.session_secret, &session);
    let body = ADMIN_HTML
        .replace("{{CSRF_TOKEN}}", &csrf)
        .replace("{{ADMIN_PATH}}", &state.admin.path);
    let mut resp = (StatusCode::OK, body).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    apply_admin_headers(resp.headers_mut());
    resp
}

// ==================================================================
// GET {ADMIN_PATH}/logout
// ==================================================================

pub async fn logout(_: RequireAdmin) -> Response {
    let mut resp = AppError::NotFound.into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, clear_cookie(SESSION_COOKIE));
    apply_admin_headers(resp.headers_mut());
    resp
}

// ==================================================================
// GET {ADMIN_PATH}/dids
// ==================================================================

pub async fn list_dids(
    _: RequireAdmin,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let rows = db::list_all_did_handle_pairs(state.service.pool()).await?;

    // Group the flat (did, sub, created_at) rows into { did → [handles] }.
    // Rows where `sub` is empty come from the LEFT JOIN and mean "DID has
    // no handles" — rare in practice but worth rendering as an empty list.
    let mut grouped: Vec<(String, Vec<Value>)> = Vec::new();
    for (did, sub, created_at) in rows {
        if let Some((_, handles)) = grouped.last_mut().filter(|(d, _)| d == &did) {
            if !sub.is_empty() {
                handles.push(json!({ "sub": sub, "created_at": created_at }));
            }
        } else {
            let mut handles = Vec::new();
            if !sub.is_empty() {
                handles.push(json!({ "sub": sub, "created_at": created_at }));
            }
            grouped.push((did, handles));
        }
    }

    let payload = grouped
        .into_iter()
        .map(|(did, handles)| json!({ "did": did, "handles": handles }))
        .collect::<Vec<_>>();
    let mut resp = Json(json!({ "dids": payload })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/delete-handle
// ==================================================================

#[derive(Deserialize)]
pub struct DeleteHandleRequest {
    pub did: String,
    pub sub: String,
}

pub async fn delete_handle(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<DeleteHandleRequest>,
) -> AppResult<Response> {
    let outcome =
        db::delete_handle_and_maybe_did(state.service.pool(), &req.did, &req.sub).await?;
    let (ok, did_dropped) = match outcome {
        db::DeleteOutcome::NotFound => (false, false),
        db::DeleteOutcome::Deleted { did_dropped } => (true, did_dropped),
    };
    if ok {
        db::log_event(
            state.service.pool(),
            EventType::Delete,
            Some(&req.did),
            Some(&req.sub),
            None,
        )
        .await?;
    }
    let mut resp =
        Json(json!({ "ok": ok, "did_dropped": did_dropped })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/delete-did
// ==================================================================

#[derive(Deserialize)]
pub struct DeleteDidRequest {
    pub did: String,
}

pub async fn delete_did(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<DeleteDidRequest>,
) -> AppResult<Response> {
    let removed = db::delete_did_and_handles(state.service.pool(), &req.did).await?;
    if removed > 0 {
        db::log_event(
            state.service.pool(),
            EventType::AdminDeleteAll,
            Some(&req.did),
            None,
            None,
        )
        .await?;
    }
    let mut resp = Json(json!({ "ok": removed > 0 })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// GET {ADMIN_PATH}/config
// ==================================================================

pub async fn get_config(
    _: RequireAdmin,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let pool = state.service.pool();
    let payload = json!({
        "vip_dids":         db::config_list_all(pool, ConfigList::VipDids).await?,
        "blocked_dids":     db::config_list_all(pool, ConfigList::BlockedDids).await?,
        "blocked_pds":      db::config_list_all(pool, ConfigList::BlockedPds).await?,
        "blocked_keywords": db::config_list_all(pool, ConfigList::BlockedKeywords).await?,
        "reserved_handles": db::config_list_all(pool, ConfigList::ReservedHandles).await?,
    });
    let mut resp = Json(payload).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/config — mutate a single list
// ==================================================================

#[derive(Deserialize)]
#[serde(tag = "action")]
pub enum ConfigMutation {
    #[serde(rename = "addVipDid")]
    AddVipDid { value: String, #[serde(default)] note: Option<String> },
    #[serde(rename = "removeVipDid")]
    RemoveVipDid { value: String },
    #[serde(rename = "addBlockDid")]
    AddBlockDid { value: String, #[serde(default)] note: Option<String> },
    #[serde(rename = "removeBlockDid")]
    RemoveBlockDid { value: String },
    #[serde(rename = "addBlockPds")]
    AddBlockPds { value: String, #[serde(default)] note: Option<String> },
    #[serde(rename = "removeBlockPds")]
    RemoveBlockPds { value: String },
    #[serde(rename = "addBlockKeyword")]
    AddBlockKeyword { value: String, #[serde(default)] note: Option<String> },
    #[serde(rename = "removeBlockKeyword")]
    RemoveBlockKeyword { value: String },
    #[serde(rename = "addReserved")]
    AddReserved { value: String, #[serde(default)] note: Option<String> },
    #[serde(rename = "removeReserved")]
    RemoveReserved { value: String },
}

pub async fn post_config(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<ConfigMutation>,
) -> AppResult<Response> {
    let pool = state.service.pool();
    // §3: "subdomains, DIDs, pds hosts, and keywords are all lowercased
    // on insert". Normalize per list type so lookups later match.
    let ok = match req {
        ConfigMutation::AddVipDid { value, note } => {
            let v = validate::normalize_did(&value);
            db::config_add(pool, ConfigList::VipDids, &v, note.as_deref()).await?;
            true
        }
        ConfigMutation::RemoveVipDid { value } => {
            db::config_remove(pool, ConfigList::VipDids, &validate::normalize_did(&value)).await?
        }
        ConfigMutation::AddBlockDid { value, note } => {
            let v = validate::normalize_did(&value);
            db::config_add(pool, ConfigList::BlockedDids, &v, note.as_deref()).await?;
            true
        }
        ConfigMutation::RemoveBlockDid { value } => {
            db::config_remove(
                pool,
                ConfigList::BlockedDids,
                &validate::normalize_did(&value),
            )
            .await?
        }
        ConfigMutation::AddBlockPds { value, note } => {
            let v = validate::normalize_pds_host(&value);
            db::config_add(pool, ConfigList::BlockedPds, &v, note.as_deref()).await?;
            true
        }
        ConfigMutation::RemoveBlockPds { value } => {
            db::config_remove(
                pool,
                ConfigList::BlockedPds,
                &validate::normalize_pds_host(&value),
            )
            .await?
        }
        ConfigMutation::AddBlockKeyword { value, note } => {
            let v = validate::normalize_keyword(&value);
            db::config_add(pool, ConfigList::BlockedKeywords, &v, note.as_deref()).await?;
            true
        }
        ConfigMutation::RemoveBlockKeyword { value } => {
            db::config_remove(
                pool,
                ConfigList::BlockedKeywords,
                &validate::normalize_keyword(&value),
            )
            .await?
        }
        ConfigMutation::AddReserved { value, note } => {
            let v = validate::normalize_subdomain(&value);
            db::config_add(pool, ConfigList::ReservedHandles, &v, note.as_deref()).await?;
            true
        }
        ConfigMutation::RemoveReserved { value } => {
            db::config_remove(
                pool,
                ConfigList::ReservedHandles,
                &validate::normalize_subdomain(&value),
            )
            .await?
        }
    };
    let mut resp = Json(json!({ "ok": ok })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// GET {ADMIN_PATH}/activity
// ==================================================================

pub async fn activity(
    _: RequireAdmin,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let rows = db::recent_activity(state.service.pool(), db::ACTIVITY_LOG_CAP).await?;
    let mut resp = Json(json!({ "events": rows })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// GET {ADMIN_PATH}/metrics
// ==================================================================

/// Derived from `activity_log`: registration counts for the last hour
/// and last 24h, plus the top PDS hosts seen in the log. IP spikes are
/// not derivable without an IP column in the log; they stay out until
/// a schema change adds one.
pub async fn metrics(
    _: RequireAdmin,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let rows = db::recent_activity(state.service.pool(), db::ACTIVITY_LOG_CAP).await?;
    let now = Utc::now();
    let h1 = (now - ChronoDuration::hours(1)).to_rfc3339();
    let h24 = (now - ChronoDuration::hours(24)).to_rfc3339();

    let reg_1h = rows
        .iter()
        .filter(|r| r.event_type == "register" && r.ts >= h1)
        .count();
    let reg_24h = rows
        .iter()
        .filter(|r| r.event_type == "register" && r.ts >= h24)
        .count();

    let mut pds_counts: HashMap<String, i64> = HashMap::new();
    for row in &rows {
        if let Some(host) = &row.pds_host {
            *pds_counts.entry(host.clone()).or_insert(0) += 1;
        }
    }
    let mut top_pds: Vec<(String, i64)> = pds_counts.into_iter().collect();
    top_pds.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top_pds.truncate(10);

    let mut resp = Json(json!({
        "registrations_1h": reg_1h,
        "registrations_24h": reg_24h,
        "top_pds_hosts": top_pds
            .into_iter()
            .map(|(host, count)| json!({ "host": host, "count": count }))
            .collect::<Vec<_>>(),
    }))
    .into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/resolve
// ==================================================================

#[derive(Deserialize)]
pub struct ResolveRequest {
    pub handle: String,
}

pub async fn resolve_handle(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<ResolveRequest>,
) -> AppResult<Response> {
    let did = state.service.admin_resolve_handle(&req.handle).await;
    let mut resp = Json(json!({ "ok": did.is_some(), "did": did })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/assign-handle
// ==================================================================

#[derive(Deserialize)]
pub struct AssignHandleRequest {
    pub did: String,
    pub sub: String,
}

pub async fn assign_handle(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<AssignHandleRequest>,
) -> AppResult<Response> {
    let result = state.service.admin_assign_handle(&req.did, &req.sub).await?;
    let mut resp = Json(json!({
        "ok": true,
        "did": result.did,
        "handle": result.handle,
        "secret_key": result.secret_key,
    }))
    .into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/preview-keyword
// ==================================================================

#[derive(Deserialize)]
pub struct PreviewKeywordRequest {
    pub keyword: String,
}

pub async fn preview_keyword(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<PreviewKeywordRequest>,
) -> AppResult<Response> {
    let matches = db::handles_matching_keyword(state.service.pool(), &req.keyword).await?;
    let mut resp = Json(json!({
        "keyword": req.keyword,
        "matches": matches,
        "count": matches.len(),
    }))
    .into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// GET {ADMIN_PATH}/export-config
// ==================================================================

pub async fn export_config(
    _: RequireAdmin,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let pool = state.service.pool();
    let payload = json!({
        "vip_dids":         db::config_list_all(pool, ConfigList::VipDids).await?,
        "blocked_dids":     db::config_list_all(pool, ConfigList::BlockedDids).await?,
        "blocked_pds":      db::config_list_all(pool, ConfigList::BlockedPds).await?,
        "blocked_keywords": db::config_list_all(pool, ConfigList::BlockedKeywords).await?,
        "reserved_handles": db::config_list_all(pool, ConfigList::ReservedHandles).await?,
    });
    let body = serde_json::to_string_pretty(&payload).expect("json serialize");
    let mut resp = (StatusCode::OK, body).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"anarchy-config.json\""),
    );
    apply_admin_headers(h);
    Ok(resp)
}

// ==================================================================
// POST {ADMIN_PATH}/import-config
// ==================================================================

#[derive(Deserialize)]
pub struct ImportConfigRequest {
    #[serde(default)]
    pub vip_dids: Vec<ConfigRow>,
    #[serde(default)]
    pub blocked_dids: Vec<ConfigRow>,
    #[serde(default)]
    pub blocked_pds: Vec<ConfigRow>,
    #[serde(default)]
    pub blocked_keywords: Vec<ConfigRow>,
    #[serde(default)]
    pub reserved_handles: Vec<ConfigRow>,
}

pub async fn import_config(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<ImportConfigRequest>,
) -> AppResult<Response> {
    db::replace_all_config(
        state.service.pool(),
        &[
            (ConfigList::VipDids, req.vip_dids),
            (ConfigList::BlockedDids, req.blocked_dids),
            (ConfigList::BlockedPds, req.blocked_pds),
            (ConfigList::BlockedKeywords, req.blocked_keywords),
            (ConfigList::ReservedHandles, req.reserved_handles),
        ],
    )
    .await?;
    let mut resp = Json(json!({ "ok": true })).into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// GET {ADMIN_PATH}/export-registry
// ==================================================================

#[derive(Deserialize, Default)]
pub struct ExportRegistryParams {
    #[serde(default)]
    pub format: Option<String>,
}

pub async fn export_registry(
    _: RequireAdmin,
    State(state): State<AppState>,
    Query(params): Query<ExportRegistryParams>,
) -> AppResult<Response> {
    let pool = state.service.pool();
    let dids = db::dump_all_dids(pool).await?;
    let handles = db::dump_all_handles(pool).await?;

    let fmt = params.format.as_deref().unwrap_or("json");
    match fmt {
        "csv" => {
            let mut body = String::from("sub,did,created_at\n");
            for h in &handles {
                // Handles come from our normalized tables so they can't
                // legally contain commas or quotes — no CSV escaping
                // needed for the v1 export format.
                body.push_str(&format!("{},{},{}\n", h.sub, h.did, h.created_at));
            }
            let mut resp = (StatusCode::OK, body).into_response();
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/csv; charset=utf-8"),
            );
            h.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"anarchy-registry.csv\""),
            );
            apply_admin_headers(h);
            Ok(resp)
        }
        _ => {
            let body = serde_json::to_string_pretty(&json!({
                "dids": dids,
                "handles": handles,
            }))
            .expect("json serialize");
            let mut resp = (StatusCode::OK, body).into_response();
            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            h.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static("attachment; filename=\"anarchy-registry.json\""),
            );
            apply_admin_headers(h);
            Ok(resp)
        }
    }
}

// ==================================================================
// POST {ADMIN_PATH}/import-registry
// ==================================================================

#[derive(Deserialize)]
pub struct ImportRegistryRequest {
    #[serde(default)]
    pub dids: Vec<DidRow>,
    #[serde(default)]
    pub handles: Vec<HandleRow>,
}

pub async fn import_registry(
    _: RequireAdmin,
    _: CsrfOk,
    State(state): State<AppState>,
    Json(req): Json<ImportRegistryRequest>,
) -> AppResult<Response> {
    db::replace_registry(state.service.pool(), &req.dids, &req.handles).await?;
    let mut resp = Json(json!({
        "ok": true,
        "dids_imported": req.dids.len(),
        "handles_imported": req.handles.len(),
    }))
    .into_response();
    apply_admin_headers(resp.headers_mut());
    Ok(resp)
}

// ==================================================================
// helpers
// ==================================================================

/// §4.4: "all admin responses include `Cache-Control: no-store, private`"
/// to prevent CDN caching of authenticated content.
fn apply_admin_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, private"),
    );
}
