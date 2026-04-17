//! Axum router wiring per DESIGN.md §5.
//!
//! The admin surface is mounted under `{ADMIN_PATH}` — a per-deployment
//! obscure prefix (§4.4). The path comes from the `ADMIN_PATH` env var,
//! so we compose the router at runtime rather than with a static prefix.
//!
//! §4.3 non-enumeration: the `fallback` returns `404 not found` for every
//! unknown path, matching the response shape `AppError::NotFound` uses.

use axum::{
    Router,
    http::StatusCode,
    routing::{get, post},
};

use crate::handlers::{AppState, admin, public};

pub fn build(state: AppState) -> Router {
    let admin_path = state.admin.path.clone();
    let p = |suffix: &str| format!("{admin_path}{suffix}");

    let public_routes = Router::new()
        .route("/", get(public::index_page))
        .route("/m", get(public::manage_page))
        .route("/a", get(public::about_page))
        .route("/themes", get(public::themes))
        .route("/register", post(public::register))
        .route("/manage", post(public::manage))
        .route(
            "/.well-known/atproto-did",
            get(public::wellknown_atproto_did),
        );

    // Sub-routes first (most specific), then the bare {ADMIN_PATH}
    // console/login route. Each POST handler's own extractors enforce
    // session + CSRF — routing alone is not the gate.
    let admin_routes = Router::new()
        .route(&p("/logout"), get(admin::logout))
        .route(&p("/dids"), get(admin::list_dids))
        .route(&p("/delete-handle"), post(admin::delete_handle))
        .route(&p("/delete-did"), post(admin::delete_did))
        .route(
            &p("/config"),
            get(admin::get_config).post(admin::post_config),
        )
        .route(&p("/activity"), get(admin::activity))
        .route(&p("/metrics"), get(admin::metrics))
        .route(&p("/resolve"), post(admin::resolve_handle))
        .route(&p("/assign-handle"), post(admin::assign_handle))
        .route(&p("/preview-keyword"), post(admin::preview_keyword))
        .route(&p("/export-config"), get(admin::export_config))
        .route(&p("/import-config"), post(admin::import_config))
        .route(&p("/export-registry"), get(admin::export_registry))
        .route(&p("/import-registry"), post(admin::import_registry))
        .route(
            admin_path.as_ref(),
            get(admin::console).post(admin::login),
        );

    public_routes
        .merge(admin_routes)
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
        .with_state(state)
}
