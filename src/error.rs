//! Error types for the registry service.
//!
//! The error model is shaped by two rules from DESIGN.md:
//!
//! - §5 specifies the exact user-facing JSON messages for `/register` and
//!   `/manage` failure modes.
//! - §4.3 ("mixed status codes → uniform 404s") collapses everything else —
//!   unknown paths, unauthenticated admin access, rate-limited requests,
//!   wrong admin passwords — into a single `404 not found` so the surface
//!   is non-enumerable.
//!
//! So `AppError` has three tiers:
//!
//! 1. `Invalid*` / `HandleUnavailable` / `InvalidSecret` etc. — the only
//!    variants that produce distinguishable response bodies (JSON with a
//!    fixed, user-facing string).
//! 2. `NotFound` — the non-enumeration collapse. Renders `404 not found`.
//! 3. `Database` / `Internal` — unexpected failures. Logged via `tracing`;
//!    the client sees an opaque `500`.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::fmt;

pub type AppResult<T> = std::result::Result<T, AppError>;

#[derive(Debug)]
pub enum AppError {
    // ----- /register (DESIGN.md §5) -----
    /// Subdomain failed validation (length, character set, hyphen rules…).
    InvalidHandleFormat,
    /// Unified rejection for taken, reserved, blocked-keyword, blocked-DID,
    /// and blocked-PDS. §4.3 requires a single message so callers cannot
    /// distinguish the underlying reason.
    HandleUnavailable,
    /// Upstream resolution (PLC / bsky appview) did not return a DID for
    /// the supplied handle. Covers genuine 404s and network failures alike
    /// — from the user's perspective both mean "we couldn't resolve it".
    UnresolvableBlueskyHandle,
    /// DID already has the per-DID handle cap (5 for normal, unlimited for
    /// VIP per §7).
    HandleLimitReached,

    // ----- /manage (DESIGN.md §5) -----
    /// Secret missing, malformed, or not matching any stored hash. The
    /// wrong-vs-nonexistent distinction is intentionally collapsed (§7).
    InvalidSecret,
    /// Secret is valid but the named sub is not owned by its DID.
    SecretDoesNotControlHandle,

    // ----- non-enumeration collapse (DESIGN.md §4.3) -----
    /// Catch-all for anything that should render as plain `404 not found`:
    /// unknown paths, unauthenticated admin requests, rate-limit hits,
    /// `.well-known/atproto-did` misses, wrong admin password.
    NotFound,

    // ----- internal; never leaks detail to the client -----
    Database(sqlx::Error),
    Internal(String),
}

impl AppError {
    /// User-facing string for variants that are allowed to be
    /// distinguishable (the /register and /manage JSON errors in §5).
    /// `None` means the variant is either opaque (`NotFound`) or internal.
    fn user_message(&self) -> Option<&'static str> {
        match self {
            AppError::InvalidHandleFormat => Some(
                "Handle must be 4-40 characters, lowercase letters, digits, or hyphens.",
            ),
            AppError::HandleUnavailable => Some("This handle is not available."),
            AppError::UnresolvableBlueskyHandle => {
                Some("Could not resolve your Bluesky handle.")
            }
            AppError::HandleLimitReached => {
                Some("Handle limit reached. Contact the operator for assistance.")
            }
            AppError::InvalidSecret => Some("Invalid secret key."),
            AppError::SecretDoesNotControlHandle => {
                Some("This secret does not control that handle.")
            }
            AppError::NotFound | AppError::Database(_) | AppError::Internal(_) => None,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::InvalidHandleFormat => f.write_str("invalid handle format"),
            AppError::HandleUnavailable => f.write_str("handle unavailable"),
            AppError::UnresolvableBlueskyHandle => {
                f.write_str("unresolvable bluesky handle")
            }
            AppError::HandleLimitReached => f.write_str("handle limit reached"),
            AppError::InvalidSecret => f.write_str("invalid secret"),
            AppError::SecretDoesNotControlHandle => {
                f.write_str("secret does not control handle")
            }
            AppError::NotFound => f.write_str("not found"),
            AppError::Database(e) => write!(f, "database error: {e}"),
            AppError::Internal(msg) => write!(f, "internal error: {msg}"),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Database(e) => Some(e),
            _ => None,
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Database(e)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if let Some(msg) = self.user_message() {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
        }
        match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found").into_response(),
            AppError::Database(e) => {
                tracing::error!(error = %e, "database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
            }
            AppError::Internal(msg) => {
                tracing::error!(error = %msg, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
            }
            _ => unreachable!("user-facing variants handled above"),
        }
    }
}
