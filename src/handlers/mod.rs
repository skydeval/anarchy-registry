//! HTTP handlers. Two halves:
//!
//! - [`public`]: `/register`, `/manage`, `/.well-known/atproto-did`,
//!   `/themes`, and the themed HTML pages.
//! - [`admin`]: the `{ADMIN_PATH}/*` surface — all gated by a session
//!   cookie, all collapsing to 404 when unauthenticated (§4.3 / §4.4).
//!
//! This file owns the shared pieces: application state, the client-IP
//! extractor, and the cookie helper. Handlers themselves live in the
//! sibling modules.

pub mod admin;
pub mod public;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::{HeaderMap, HeaderValue, request::Parts};

use crate::atproto::AtprotoClient;
use crate::error::AppError;
use crate::rate_limit::RateLimiter;
use crate::service::Service;

/// State injected into every handler via `State<AppState>`. `Clone` is
/// cheap — the `Service` is behind `Arc`, `RateLimiter` and `AdminConfig`
/// are `Clone`, `base_domain` is `Arc<str>`.
#[derive(Clone)]
pub struct AppState {
    pub service: Arc<Service<AtprotoClient>>,
    pub rate_limiter: RateLimiter,
    pub admin: AdminConfig,
    pub base_domain: Arc<str>,
}

#[derive(Clone)]
pub struct AdminConfig {
    /// Obscure, configurable path from `ADMIN_PATH` (§4.4). Leading slash
    /// included — e.g. `/x9k2m-admin`.
    pub path: Arc<str>,
    /// argon2id PHC string from `ADMIN_PASSWORD_HASH`.
    pub password_hash: Arc<str>,
    /// HMAC key for session + CSRF tokens, from `ADMIN_SESSION_SECRET`.
    pub session_secret: Arc<[u8]>,
    /// Session lifetime in seconds. Hard-coded default; no config hook
    /// until an operator asks for one.
    pub session_ttl_seconds: i64,
}

/// Client IP as resolved from trusted proxy headers.
///
/// Lookup order matches the deployment (§8): `cf-connecting-ip` is set
/// by cloudflare, `x-forwarded-for` is set by caddy. Behind both, either
/// header is authoritative. Falls back to the socket address so `cargo
/// run` against 127.0.0.1 still works in dev.
///
/// Extraction failure never surfaces — we return `0.0.0.0` and let the
/// rate limiter bucket all such requests together. That's a conservative
/// choice: it can't under-count, it can over-count (which is the safe
/// direction for a limiter).
#[derive(Clone, Copy, Debug)]
pub struct ClientIp(pub IpAddr);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        if let Some(ip) = read_ip_header(&parts.headers, "cf-connecting-ip") {
            return Ok(ClientIp(ip));
        }
        if let Some(xff) = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(first) = xff.split(',').next() {
                if let Ok(ip) = first.trim().parse() {
                    return Ok(ClientIp(ip));
                }
            }
        }
        if let Some(ConnectInfo(addr)) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
            return Ok(ClientIp(addr.ip()));
        }
        Ok(ClientIp(IpAddr::from([0, 0, 0, 0])))
    }
}

fn read_ip_header(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// Parse a single cookie out of a `Cookie:` header. Avoids pulling in
/// `axum-extra` for what is effectively three lines of string handling.
pub fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get("cookie")?.to_str().ok()?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some(val) = pair.strip_prefix(&format!("{name}=")) {
            return Some(val.to_string());
        }
    }
    None
}

/// Build a `Set-Cookie` header value for a session/CSRF cookie. `HttpOnly`
/// is always set; `Secure` matches §8 (behind cloudflare https); `SameSite=Lax`
/// is the primary CSRF defense (§4.4).
pub fn session_cookie(name: &str, value: &str, max_age_seconds: i64) -> HeaderValue {
    let raw = format!(
        "{name}={value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={max_age_seconds}",
    );
    HeaderValue::from_str(&raw).expect("cookie value is ASCII")
}

pub fn clear_cookie(name: &str) -> HeaderValue {
    let raw = format!("{name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    HeaderValue::from_str(&raw).expect("cookie value is ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn read_cookie_finds_named_value() {
        let mut h = HeaderMap::new();
        h.insert(
            "cookie",
            HeaderValue::from_static("a=1; anarchy_session=abc.def; b=2"),
        );
        assert_eq!(
            read_cookie(&h, "anarchy_session").as_deref(),
            Some("abc.def")
        );
        assert_eq!(read_cookie(&h, "missing"), None);
    }

    #[test]
    fn session_cookie_has_expected_attributes() {
        let v = session_cookie("s", "tok", 3600);
        let s = v.to_str().unwrap();
        assert!(s.contains("s=tok"));
        assert!(s.contains("HttpOnly"));
        assert!(s.contains("Secure"));
        assert!(s.contains("SameSite=Lax"));
        assert!(s.contains("Max-Age=3600"));
    }
}
