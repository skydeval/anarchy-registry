//! End-to-end tests for the registry HTTP surface.
//!
//! These tests drive the real `axum::Router` built by `routes::build` via
//! `tower::ServiceExt::oneshot`, so the request path exercises every
//! layer the way a real client would: extractors, handlers, service,
//! rate limiter, DB, error mapping, headers, cookies.
//!
//! What's **not** here: paths that hit `atproto` (handle resolution /
//! PLC lookup) require either a mock server or the real network —
//! neither is load-bearing for HTTP-layer verification. The register
//! flow is covered by service-layer unit tests with a MockResolver; the
//! integration tests seed DB state directly to exercise the endpoints
//! that depend on it (`/.well-known/atproto-did`, `/manage`, and the
//! full admin surface).

use std::sync::Arc;

use anarchy_registry::atproto::AtprotoClient;
use anarchy_registry::handlers::{AdminConfig, AppState};
use anarchy_registry::rate_limit::RateLimiter;
use anarchy_registry::service::Service;
use anarchy_registry::{auth, db, routes};

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use tower::util::ServiceExt;

// ==================================================================
// harness
// ==================================================================

const TEST_ADMIN_PATH: &str = "/x9k2m-admin";
const TEST_ADMIN_PASSWORD: &str = "hunter2-test";
const TEST_SESSION_SECRET: [u8; 32] = [7u8; 32];
const TEST_BASE_DOMAIN: &str = "anarchy.lgbt";

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

async fn build_state() -> (AppState, SqlitePool) {
    let pool = test_pool().await;
    let rate_limiter = RateLimiter::new(pool.clone(), vec![]);
    // AtprotoClient is a real client pointed at an unresolvable host so
    // any accidental network call would fail fast; no test here triggers
    // one.
    let atproto = AtprotoClient::with_endpoints(
        "http://127.0.0.1:1".into(),
        "http://127.0.0.1:1".into(),
    );
    let service = Arc::new(Service::new(
        pool.clone(),
        atproto,
        rate_limiter.clone(),
        TEST_BASE_DOMAIN.to_string(),
    ));
    let password_hash = auth::hash_admin_password(TEST_ADMIN_PASSWORD).unwrap();
    let state = AppState {
        service,
        rate_limiter,
        admin: AdminConfig {
            path: Arc::from(TEST_ADMIN_PATH),
            password_hash: Arc::from(password_hash),
            session_secret: Arc::from(TEST_SESSION_SECRET.to_vec().into_boxed_slice()),
            session_ttl_seconds: 3600,
        },
        base_domain: Arc::from(TEST_BASE_DOMAIN),
    };
    (state, pool)
}

async fn body_bytes(resp: axum::response::Response) -> Vec<u8> {
    let body = resp.into_body();
    axum::body::to_bytes(body, usize::MAX).await.unwrap().to_vec()
}

async fn body_string(resp: axum::response::Response) -> String {
    String::from_utf8_lossy(&body_bytes(resp).await).into_owned()
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = body_bytes(resp).await;
    serde_json::from_slice(&bytes).expect("response is JSON")
}

/// Extract a named cookie's value from the response's `Set-Cookie`
/// headers. Returns `None` if not present.
fn extract_cookie(resp: &axum::response::Response, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    for v in resp.headers().get_all(header::SET_COOKIE) {
        let s = v.to_str().ok()?;
        let first = s.split(';').next()?.trim();
        if let Some(val) = first.strip_prefix(&prefix) {
            return Some(val.to_string());
        }
    }
    None
}

/// Log in and return `(session_cookie_value, csrf_token)`. Fails the
/// test on wrong password or any non-success status.
async fn admin_login(app: axum::Router) -> (String, String) {
    let req = Request::builder()
        .method("POST")
        .uri(TEST_ADMIN_PATH)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "password": TEST_ADMIN_PASSWORD }).to_string(),
        ))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "login should succeed");
    let cookie = extract_cookie(&resp, "anarchy_session").expect("session cookie set");
    let body: Value = body_json(resp).await;
    let csrf = body["csrf_token"]
        .as_str()
        .expect("login returns csrf_token")
        .to_string();
    (cookie, csrf)
}

// ==================================================================
// public surface
// ==================================================================

#[tokio::test]
async fn unknown_path_returns_plain_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(Request::builder().uri("/does-not-exist").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_string(resp).await, "not found");
}

#[tokio::test]
async fn get_themes_returns_catalog() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(Request::builder().uri("/themes").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    assert_eq!(body.as_array().unwrap().len(), 21);
}

#[tokio::test]
async fn index_renders_themed_html() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp.headers().get(header::CONTENT_TYPE).unwrap().to_str().unwrap();
    assert!(ct.contains("text/html"));
    let html = body_string(resp).await;
    assert!(html.contains("Seize your anarchy.lgbt"));
    assert!(html.contains("id=\"dice\""));
}

#[tokio::test]
async fn wellknown_resolves_seeded_subdomain() {
    let (state, pool) = build_state().await;
    let app = routes::build(state);
    db::register_new_did_with_handle(&pool, "did:plc:alice", "hash", "alice")
        .await
        .unwrap();
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/.well-known/atproto-did")
                .header(header::HOST, "alice.anarchy.lgbt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let cache = resp.headers().get(header::CACHE_CONTROL).unwrap().to_str().unwrap();
    assert!(cache.contains("max-age=300"));
    assert_eq!(body_string(resp).await, "did:plc:alice");
}

#[tokio::test]
async fn wellknown_missing_sub_is_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/.well-known/atproto-did")
                .header(header::HOST, "nobody.anarchy.lgbt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn manage_list_and_delete_roundtrip() {
    let (state, pool) = build_state().await;
    let app = routes::build(state);
    let secret = "test-secret-abcdef1234567890ab";
    db::register_new_did_with_handle(&pool, "did:plc:me", &auth::hash_user_secret(secret), "me")
        .await
        .unwrap();
    db::add_handle(&pool, "did:plc:me", "mealt").await.unwrap();

    // list
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/manage")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "action": "list", "secret": secret }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    assert_eq!(body["did"], "did:plc:me");
    assert_eq!(body["handles"].as_array().unwrap().len(), 2);

    // delete one
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/manage")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "action": "delete",
                        "secret": secret,
                        "sub": "mealt"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    assert_eq!(body["deleted"], "mealt.anarchy.lgbt");
    assert!(db::get_handle_by_sub(&pool, "mealt").await.unwrap().is_none());
}

#[tokio::test]
async fn manage_wrong_secret_returns_invalid_secret_error() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/manage")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "action": "list", "secret": "nope" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body: Value = body_json(resp).await;
    assert_eq!(body["error"], "Invalid secret key.");
}

// ==================================================================
// admin surface — non-enumeration + CSRF gate
// ==================================================================

#[tokio::test]
async fn admin_path_without_session_is_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(Request::builder().uri(TEST_ADMIN_PATH).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_string(resp).await, "not found");
}

#[tokio::test]
async fn admin_login_wrong_password_is_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(TEST_ADMIN_PATH)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "password": "wrong" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_login_success_issues_cookie_and_csrf() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, csrf) = admin_login(app).await;
    assert!(!cookie.is_empty());
    assert!(!csrf.is_empty());
    // CSRF is hex of HMAC-SHA256 → 64 chars.
    assert_eq!(csrf.len(), 64);
}

#[tokio::test]
async fn admin_console_substitutes_csrf_and_admin_path() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, csrf) = admin_login(app.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .uri(TEST_ADMIN_PATH)
                .header("cookie", format!("anarchy_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let html = body_string(resp).await;
    assert!(html.contains(&format!("content=\"{csrf}\"")));
    assert!(html.contains(&format!("content=\"{TEST_ADMIN_PATH}\"")));
    // No unsubstituted placeholders leaked into the served HTML.
    assert!(!html.contains("{{CSRF_TOKEN}}"));
    assert!(!html.contains("{{ADMIN_PATH}}"));
}

#[tokio::test]
async fn admin_response_sets_no_store_cache_control() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, _csrf) = admin_login(app.clone()).await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri(TEST_ADMIN_PATH)
                .header("cookie", format!("anarchy_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cc = resp
        .headers()
        .get(header::CACHE_CONTROL)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cc.contains("no-store"));
    assert!(cc.contains("private"));
}

#[tokio::test]
async fn admin_post_without_csrf_is_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, _csrf) = admin_login(app.clone()).await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("{TEST_ADMIN_PATH}/config"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "action": "addVipDid", "value": "did:plc:x" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_post_with_wrong_csrf_is_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, _csrf) = admin_login(app.clone()).await;
    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("{TEST_ADMIN_PATH}/config"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .header("x-csrf-token", "deadbeef")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "action": "addVipDid", "value": "did:plc:x" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn admin_config_add_then_get_roundtrip() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, csrf) = admin_login(app.clone()).await;

    // Add a blocked DID.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("{TEST_ADMIN_PATH}/config"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "action": "addBlockDid",
                        "value": "did:plc:bad",
                        "note": "spammer"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Fetch config — must include it.
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("{TEST_ADMIN_PATH}/config"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    let blocked = body["blocked_dids"].as_array().unwrap();
    assert_eq!(blocked.len(), 1);
    assert_eq!(blocked[0]["value"], "did:plc:bad");
    assert_eq!(blocked[0]["note"], "spammer");
}

#[tokio::test]
async fn admin_dids_lists_seeded_state() {
    let (state, pool) = build_state().await;
    db::register_new_did_with_handle(&pool, "did:plc:a", "h1", "alice")
        .await
        .unwrap();
    db::add_handle(&pool, "did:plc:a", "allie").await.unwrap();
    db::register_new_did_with_handle(&pool, "did:plc:b", "h2", "bob")
        .await
        .unwrap();
    let app = routes::build(state);
    let (cookie, _csrf) = admin_login(app.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("{TEST_ADMIN_PATH}/dids"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    let dids = body["dids"].as_array().unwrap();
    assert_eq!(dids.len(), 2);
    let alice_row = dids.iter().find(|r| r["did"] == "did:plc:a").unwrap();
    assert_eq!(alice_row["handles"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn admin_delete_handle_requires_csrf_and_removes_row() {
    let (state, pool) = build_state().await;
    db::register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
        .await
        .unwrap();
    db::add_handle(&pool, "did:plc:a", "allie").await.unwrap();
    let app = routes::build(state);
    let (cookie, csrf) = admin_login(app.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("{TEST_ADMIN_PATH}/delete-handle"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "did": "did:plc:a", "sub": "allie" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["did_dropped"], false);
    assert!(db::get_handle_by_sub(&pool, "allie").await.unwrap().is_none());
    assert!(db::get_handle_by_sub(&pool, "alice").await.unwrap().is_some());
}

#[tokio::test]
async fn admin_export_config_is_attached_json() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, _csrf) = admin_login(app.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("{TEST_ADMIN_PATH}/export-config"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let cd = resp
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cd.contains("attachment"));
    assert!(cd.contains("anarchy-config.json"));
    // Body is valid JSON with the five list keys.
    let body: Value = body_json(resp).await;
    for key in [
        "vip_dids",
        "blocked_dids",
        "blocked_pds",
        "blocked_keywords",
        "reserved_handles",
    ] {
        assert!(body.get(key).is_some(), "missing {key}");
    }
}

#[tokio::test]
async fn admin_logout_clears_cookie_and_returns_404() {
    let (state, _) = build_state().await;
    let app = routes::build(state);
    let (cookie, _csrf) = admin_login(app.clone()).await;
    let resp = app
        .oneshot(
            Request::builder()
                .uri(format!("{TEST_ADMIN_PATH}/logout"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    // Set-Cookie for the session must be present and expiring.
    let set_cookie = resp
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.contains("anarchy_session="));
    assert!(set_cookie.contains("Max-Age=0"));
}

#[tokio::test]
async fn admin_preview_keyword_returns_registered_matches() {
    let (state, pool) = build_state().await;
    db::register_new_did_with_handle(&pool, "did:plc:a", "h", "alice")
        .await
        .unwrap();
    db::add_handle(&pool, "did:plc:a", "malice").await.unwrap();
    db::add_handle(&pool, "did:plc:a", "bob").await.unwrap();
    let app = routes::build(state);
    let (cookie, csrf) = admin_login(app.clone()).await;

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("{TEST_ADMIN_PATH}/preview-keyword"))
                .header("cookie", format!("anarchy_session={cookie}"))
                .header("x-csrf-token", &csrf)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "keyword": "lic" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value = body_json(resp).await;
    assert_eq!(body["count"], 2);
    let matches = body["matches"].as_array().unwrap();
    assert!(matches.iter().any(|m| m == "alice"));
    assert!(matches.iter().any(|m| m == "malice"));
}
