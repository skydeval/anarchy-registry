//! Admin HTTP surface (DESIGN.md §4.4, §5).
//!
//! Routing shape:
//!
//! - `GET {ADMIN_PATH}` unauthenticated → renders a themed login page
//!   (see `admin_login.html`). The page exists, but it's bare: no
//!   heading, no labels, no error feedback. Wrong passwords just
//!   re-render the same page silently. A scanner learns the path
//!   exists; it does not learn whether any credential is close.
//! - `POST {ADMIN_PATH}` accepts a standard `application/x-www-form-urlencoded`
//!   body with a `password` field. Correct password → session cookie is
//!   set and the admin console SPA is served. Wrong password or
//!   rate-limit hit → the login page is re-rendered (200 OK, no cookie).
//! - `GET {ADMIN_PATH}` authenticated → serves the admin console SPA.
//! - All other `{ADMIN_PATH}/*` endpoints keep the strict non-enumeration
//!   rule: missing/invalid session returns `404 not found` (§4.3).
//!
//! All admin POST endpoints past login require a valid CSRF token (§4.4)
//! supplied as an `X-CSRF-Token` header. The token is rendered into the
//! admin console HTML as a `<meta>` tag, and the SPA replays it on each
//! state-changing request.

use std::collections::HashMap;

use askama::Template;
use axum::{
    Form, Json,
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
use crate::theme::{self, Theme};
use crate::validate;
use crate::wordlist;

use super::{AppState, ClientIp, clear_cookie, read_cookie, session_cookie};
use super::public::{DecorationView, randomize_gradient_direction};

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
// POST {ADMIN_PATH} — login (browser form submission)
// ==================================================================

#[derive(Deserialize)]
pub struct LoginForm {
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Form(form): Form<LoginForm>,
) -> Response {
    // Rate-limit hits and wrong passwords are indistinguishable from
    // the user's perspective — both just re-render the login page
    // silently, no cookie set. That's the non-enumeration compromise:
    // the path reveals a login page exists, but no attempt gives away
    // whether it was close to correct.
    let allowed = state.rate_limiter.is_trusted(ip)
        || state
            .rate_limiter
            .allow_admin_login(ip)
            .await
            .unwrap_or(false);
    if !allowed || !auth::verify_admin_password(&form.password, &state.admin.password_hash) {
        return render_login_page(&state);
    }

    let (session, cookie_value) =
        auth::issue_session(&state.admin.session_secret, state.admin.session_ttl_seconds);
    let mut resp = render_admin_console(&state, &session);
    resp.headers_mut().append(
        header::SET_COOKIE,
        session_cookie(
            SESSION_COOKIE,
            &cookie_value,
            state.admin.session_ttl_seconds,
        ),
    );
    resp
}

// ==================================================================
// GET {ADMIN_PATH} — console or login page depending on auth state
// ==================================================================

/// Embedded admin SPA (§11). Two placeholders — `{{CSRF_TOKEN}}` and
/// `{{ADMIN_PATH}}` — are substituted server-side before the page hits
/// the network, so the SPA can pin its CSRF header and build API URLs
/// without a bootstrap round-trip.
const ADMIN_HTML: &str = include_str!("../../static/admin.html");

pub async fn console(headers: HeaderMap, State(state): State<AppState>) -> Response {
    match session_from_headers(&headers, &state) {
        Some(session) => render_admin_console(&state, &session),
        None => render_login_page(&state),
    }
}

/// Try to extract and verify the session from the request's cookies.
/// Returns `None` for any missing/invalid/expired session — the caller
/// decides how to react (render login vs reject).
fn session_from_headers(headers: &HeaderMap, state: &AppState) -> Option<Session> {
    let raw = read_cookie(headers, SESSION_COOKIE)?;
    auth::parse_session(&state.admin.session_secret, &raw)
}

// ==================================================================
// render helpers
// ==================================================================

#[derive(Template)]
#[template(path = "admin_login.html")]
struct AdminLoginPage<'a> {
    theme: &'a Theme,
    base_domain: &'a str,
    background: String,
    deco: DecorationView,
    admin_path: &'a str,
}

fn render_login_page(state: &AppState) -> Response {
    let t = theme::pick_random();
    let tmpl = AdminLoginPage {
        theme: t,
        base_domain: &state.base_domain,
        background: randomize_gradient_direction(t.background),
        deco: DecorationView::from_theme(t),
        admin_path: &state.admin.path,
    };
    let html = tmpl
        .render()
        .unwrap_or_else(|e| format!("<!-- login template render: {e} -->"));
    let mut resp = (StatusCode::OK, html).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    apply_admin_headers(resp.headers_mut());
    resp
}

/// Compile-time version from the crate's Cargo.toml.
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn render_admin_console(state: &AppState, session: &Session) -> Response {
    let csrf = auth::csrf_token_for(&state.admin.session_secret, session);
    let body = ADMIN_HTML
        .replace("{{CSRF_TOKEN}}", &csrf)
        .replace("{{ADMIN_PATH}}", &state.admin.path)
        .replace("{{BASE_DOMAIN}}", &state.base_domain)
        .replace("{{VERSION}}", VERSION);
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
    // Clear the session cookie and redirect to the public home page
    // so the admin lands somewhere usable instead of a 404. The
    // `RequireAdmin` extractor still gates this endpoint — unauth'd
    // hits collapse to 404 per §4.3 non-enumeration.
    let mut resp = (StatusCode::FOUND, "").into_response();
    let h = resp.headers_mut();
    h.insert(header::LOCATION, HeaderValue::from_static("/"));
    h.append(header::SET_COOKIE, clear_cookie(SESSION_COOKIE));
    apply_admin_headers(h);
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

/// Upper bound on the number of matching words returned to the admin.
/// High enough to show a substantial sample without blowing up the UI
/// on very short substrings like `"e"` or `"in"`.
const KEYWORD_PREVIEW_LIMIT: usize = 50;

pub async fn preview_keyword(
    _: RequireAdmin,
    _: CsrfOk,
    State(_state): State<AppState>,
    Json(req): Json<PreviewKeywordRequest>,
) -> AppResult<Response> {
    // Check against a built-in common-English-word list rather than the
    // live handles table — the goal is to surface *false-positive risk*
    // before the block is committed, not to enumerate existing users.
    let keyword = validate::normalize_keyword(&req.keyword);
    let result = wordlist::matching(&keyword, KEYWORD_PREVIEW_LIMIT);
    let mut resp = Json(json!({
        "keyword": keyword,
        "matches": result.matches,
        "count": result.total,
        "shown": result.matches.len(),
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
