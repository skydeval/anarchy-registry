//! Public HTTP surface: `/register`, `/manage`, `/.well-known/atproto-did`,
//! `/themes`, and the themed HTML pages (`/`, `/m`, `/a`).

use askama::Template;
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::service;
use crate::theme::{self, Decoration, Theme};

use super::{AppState, ClientIp};

// ==================================================================
// POST /register
// ==================================================================

#[derive(Deserialize)]
pub struct RegisterRequest {
    /// The user's bluesky handle, e.g. `alice.bsky.social`.
    pub handle: String,
    /// The subdomain they want, e.g. `alice` (→ `alice.anarchy.lgbt`).
    pub subdomain: String,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    ok: bool,
    #[serde(flatten)]
    result: service::RegisterResult,
}

pub async fn register(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Json<RegisterResponse>> {
    let result = state
        .service
        .register(&req.handle, &req.subdomain, ip)
        .await?;
    Ok(Json(RegisterResponse { ok: true, result }))
}

// ==================================================================
// POST /manage — list | delete (discriminated by `action`)
// ==================================================================

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
pub enum ManageRequest {
    List { secret: String },
    Delete { secret: String, sub: String },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ManageResponse {
    List {
        ok: bool,
        #[serde(flatten)]
        result: service::ListResult,
    },
    Delete {
        ok: bool,
        #[serde(flatten)]
        result: service::DeleteResult,
    },
}

pub async fn manage(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<ManageRequest>,
) -> AppResult<Json<ManageResponse>> {
    match req {
        ManageRequest::List { secret } => {
            let result = state.service.list_handles(&secret, ip).await?;
            Ok(Json(ManageResponse::List { ok: true, result }))
        }
        ManageRequest::Delete { secret, sub } => {
            let result = state.service.delete_handle(&secret, &sub, ip).await?;
            Ok(Json(ManageResponse::Delete { ok: true, result }))
        }
    }
}

// ==================================================================
// GET /.well-known/atproto-did
// ==================================================================

/// Per-subdomain: takes the `Host` header, strips the base domain, and
/// looks up the mapped DID. §5 shape: `text/plain` body, 5-minute cache.
/// Every failure is an identical `404 not found` (§4.3).
pub async fn wellknown_atproto_did(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or(AppError::NotFound)?;
    let sub = extract_subdomain(host, &state.base_domain).ok_or(AppError::NotFound)?;
    let did = state.service.resolve_sub_to_did(sub).await?;

    let mut resp = (StatusCode::OK, did).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    Ok(resp)
}

fn extract_subdomain<'a>(host: &'a str, base_domain: &str) -> Option<&'a str> {
    let host = host.split(':').next()?;
    if host.len() <= base_domain.len() {
        return None;
    }
    let rest = host.strip_suffix(base_domain)?;
    rest.strip_suffix('.')
}

// ==================================================================
// GET /themes
// ==================================================================

pub async fn themes() -> Response {
    let body = serde_json::to_string(theme::ALL).expect("theme catalog serializes");
    let mut resp = (StatusCode::OK, body).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    resp
}

// ==================================================================
// GET / · /m · /a — themed HTML pages
// ==================================================================

/// Template view of a `Theme`'s decoration. Computed once per render —
/// the random corner for a badge is picked here so every refresh can
/// shift it (§6: "random corner per render"), and so the template can
/// stay a pure view layer without touching `rand`.
struct DecorationView {
    is_sigil: bool,
    is_badge: bool,
    // Sigil fields (empty when !is_sigil; templates only read them on
    // the sigil branch).
    character: &'static str,
    placement_css: &'static str,
    color: &'static str,
    size_px: u32,
    weight: u32,
    opacity: f32,
    // CornerBadge fields.
    badge_corner: &'static str,
    badge_corner_css: &'static str,
}

impl DecorationView {
    fn from_theme(theme: &Theme) -> Self {
        match theme.decoration {
            Decoration::Sigil {
                character,
                placement,
                color,
                size_px,
                weight,
                opacity,
            } => Self {
                is_sigil: true,
                is_badge: false,
                character,
                placement_css: placement.css(),
                color,
                size_px,
                weight,
                opacity,
                badge_corner: "",
                badge_corner_css: "",
            },
            Decoration::CornerBadge { random_corner } => {
                let corner = if random_corner {
                    pick_random_corner()
                } else {
                    "bottom-right"
                };
                Self {
                    is_sigil: false,
                    is_badge: true,
                    character: "",
                    placement_css: "",
                    color: "",
                    size_px: 0,
                    weight: 0,
                    opacity: 0.0,
                    badge_corner: corner,
                    badge_corner_css: corner_css(corner),
                }
            }
            Decoration::None => Self {
                is_sigil: false,
                is_badge: false,
                character: "",
                placement_css: "",
                color: "",
                size_px: 0,
                weight: 0,
                opacity: 0.0,
                badge_corner: "",
                badge_corner_css: "",
            },
        }
    }
}

fn pick_random_corner() -> &'static str {
    const CORNERS: [&str; 4] = ["top-left", "top-right", "bottom-left", "bottom-right"];
    CORNERS[rand::thread_rng().gen_range(0..CORNERS.len())]
}

fn corner_css(corner: &str) -> &'static str {
    match corner {
        "top-left" => "position:fixed;top:2rem;left:2rem;",
        "top-right" => "position:fixed;top:2rem;right:2rem;",
        "bottom-left" => "position:fixed;bottom:2rem;left:2rem;",
        _ => "position:fixed;bottom:2rem;right:2rem;",
    }
}

/// Per-render randomization of the gradient direction so the same theme
/// can land on different orientations across reloads. Only rewrites
/// `linear-gradient(...)` values — solid colors (Intersex) pass through
/// unchanged. The current direction is parsed out of the gradient's
/// first argument and excluded from the new pick, so a reroll never
/// lands on the same orientation twice in a row. Must stay in sync
/// with the JS `randomizeGradient` in `templates/base.html`.
fn randomize_gradient_direction(bg: &str) -> String {
    const PREFIX: &str = "linear-gradient(";
    if !bg.starts_with(PREFIX) {
        return bg.to_string();
    }
    const DIRECTIONS: [&str; 4] = ["to right", "to bottom", "135deg", "45deg"];

    let rest = &bg[PREFIX.len()..];
    let comma_idx = match rest.find(',') {
        Some(i) => i,
        None => return bg.to_string(),
    };
    let current = rest[..comma_idx].trim();

    let pool: Vec<&&str> = DIRECTIONS.iter().filter(|d| **d != current).collect();
    let dir = pool[rand::thread_rng().gen_range(0..pool.len())];

    format!("{}{}{}", PREFIX, dir, &rest[comma_idx..])
}

#[derive(Template)]
#[template(path = "index.html")]
struct IndexPage<'a> {
    theme: &'a Theme,
    base_domain: &'a str,
    /// `base_domain` JSON-encoded (with surrounding quotes) so it can
    /// be dropped into a JS initializer literal without bespoke escaping.
    base_domain_json: String,
    /// The theme's `background` CSS with a randomized gradient direction
    /// baked in (solid colors pass through). The JS applies the same
    /// randomization on later swaps.
    background: String,
    deco: DecorationView,
}

#[derive(Template)]
#[template(path = "manage.html")]
struct ManagePage<'a> {
    theme: &'a Theme,
    base_domain: &'a str,
    base_domain_json: String,
    background: String,
    deco: DecorationView,
}

#[derive(Template)]
#[template(path = "about.html")]
struct AboutPage<'a> {
    theme: &'a Theme,
    base_domain: &'a str,
    background: String,
    deco: DecorationView,
}

pub async fn index_page(State(state): State<AppState>) -> AppResult<Response> {
    let t = theme::pick_random();
    render_page(IndexPage {
        theme: t,
        base_domain: &state.base_domain,
        base_domain_json: json_string(&state.base_domain),
        background: randomize_gradient_direction(t.background),
        deco: DecorationView::from_theme(t),
    })
}

pub async fn manage_page(State(state): State<AppState>) -> AppResult<Response> {
    let t = theme::pick_random();
    render_page(ManagePage {
        theme: t,
        base_domain: &state.base_domain,
        base_domain_json: json_string(&state.base_domain),
        background: randomize_gradient_direction(t.background),
        deco: DecorationView::from_theme(t),
    })
}

pub async fn about_page(State(state): State<AppState>) -> AppResult<Response> {
    let t = theme::pick_random();
    render_page(AboutPage {
        theme: t,
        base_domain: &state.base_domain,
        background: randomize_gradient_direction(t.background),
        deco: DecorationView::from_theme(t),
    })
}

fn render_page<T: Template>(tmpl: T) -> AppResult<Response> {
    let html = tmpl
        .render()
        .map_err(|e| AppError::Internal(format!("template render: {e}")))?;
    let mut resp = (StatusCode::OK, html).into_response();
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    Ok(resp)
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("string serializes to JSON")
}

// ==================================================================
// tests
// ==================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_subdomain_strips_base_and_port() {
        assert_eq!(
            extract_subdomain("alice.anarchy.lgbt", "anarchy.lgbt"),
            Some("alice")
        );
        assert_eq!(
            extract_subdomain("alice.anarchy.lgbt:8080", "anarchy.lgbt"),
            Some("alice")
        );
        assert_eq!(
            extract_subdomain("foo.bar.anarchy.lgbt", "anarchy.lgbt"),
            Some("foo.bar")
        );
        assert_eq!(extract_subdomain("anarchy.lgbt", "anarchy.lgbt"), None);
        assert_eq!(extract_subdomain("example.com", "anarchy.lgbt"), None);
        assert_eq!(
            extract_subdomain("aliceanarchy.lgbt", "anarchy.lgbt"),
            None
        );
    }

    #[test]
    fn manage_request_deserializes_both_actions() {
        let list: ManageRequest =
            serde_json::from_str(r#"{"action":"list","secret":"sk"}"#).unwrap();
        assert!(matches!(list, ManageRequest::List { .. }));
        let del: ManageRequest =
            serde_json::from_str(r#"{"action":"delete","secret":"sk","sub":"alice"}"#).unwrap();
        assert!(matches!(del, ManageRequest::Delete { .. }));
    }

    #[test]
    fn decoration_view_sigil() {
        let sigil_theme = theme::ALL.iter().find(|t| t.name == "Trans Pride").unwrap();
        let v = DecorationView::from_theme(sigil_theme);
        assert!(v.is_sigil);
        assert!(!v.is_badge);
        assert_eq!(v.character, "⚧");
        assert_eq!(v.color, "#ffffff");
    }

    #[test]
    fn decoration_view_badge_picks_a_corner() {
        let intersex = theme::ALL.iter().find(|t| t.name == "Intersex").unwrap();
        let v = DecorationView::from_theme(intersex);
        assert!(v.is_badge);
        assert!(v.badge_corner_css.contains("position:fixed"));
        assert!(["top-left", "top-right", "bottom-left", "bottom-right"].contains(&v.badge_corner));
    }

    #[test]
    fn decoration_view_none_for_did_theme() {
        let did = theme::ALL.iter().find(|t| t.name == "DID Awareness").unwrap();
        let v = DecorationView::from_theme(did);
        assert!(!v.is_sigil);
        assert!(!v.is_badge);
    }

    #[test]
    fn index_template_renders_against_a_theme() {
        let t = theme::ALL.iter().find(|t| t.name == "Trans Pride").unwrap();
        let page = IndexPage {
            theme: t,
            base_domain: "anarchy.lgbt",
            base_domain_json: json_string("anarchy.lgbt"),
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().expect("template renders");
        assert!(html.contains("Seize your anarchy.lgbt"));
        assert!(html.contains("data-theme=\"Trans Pride\""));
        assert!(html.contains("Your current Bluesky handle"));
        // The sigil got rendered.
        assert!(html.contains("⚧"));
    }

    #[test]
    fn manage_template_renders_and_has_js_base_domain() {
        let t = theme::ALL.iter().find(|t| t.name == "Gay/MLM Pride").unwrap();
        let page = ManagePage {
            theme: t,
            base_domain: "anarchy.lgbt",
            base_domain_json: json_string("anarchy.lgbt"),
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().expect("template renders");
        assert!(html.contains("Manage your handles"));
        // JS literal should be a properly-quoted JSON string.
        assert!(html.contains("const baseDomain = \"anarchy.lgbt\";"));
    }

    #[test]
    fn about_template_renders_with_no_decoration_for_did() {
        let t = theme::ALL.iter().find(|t| t.name == "DID Awareness").unwrap();
        let page = AboutPage {
            theme: t,
            base_domain: "anarchy.lgbt",
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().expect("template renders");
        assert!(html.contains("About this project"));
        // No sigil / corner-badge overlay on DID theme.
        assert!(!html.contains("class=\"sigil\""));
        assert!(!html.contains("class=\"corner-badge\""));
    }

    #[test]
    fn body_has_no_fog_class_after_opaque_shell_rework() {
        // Sanity: the old fog-mode toggle is gone. The body tag should
        // carry only the `data-theme` attribute now.
        let t = theme::ALL.iter().find(|t| t.name == "Nonbinary Pride").unwrap();
        let page = IndexPage {
            theme: t,
            base_domain: "anarchy.lgbt",
            base_domain_json: json_string("anarchy.lgbt"),
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().unwrap();
        assert!(!html.contains("class=\"fog\""));
        assert!(!html.contains("body.fog"));
    }

    #[test]
    fn dice_rendered_with_design_spec() {
        let t = theme::ALL.iter().find(|t| t.name == "Trans Pride").unwrap();
        let page = IndexPage {
            theme: t,
            base_domain: "anarchy.lgbt",
            base_domain_json: json_string("anarchy.lgbt"),
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().unwrap();
        // §6: dice glyph, 16px, opacity 0.75, default cursor, no chrome.
        assert!(html.contains("id=\"dice\""));
        assert!(html.contains("aria-label=\"shuffle theme\""));
        assert!(html.contains("font-size: 16px"));
        assert!(html.contains("opacity: 0.75"));
        assert!(html.contains("cursor: default"));
    }

    #[test]
    fn randomize_gradient_direction_excludes_current() {
        let out = randomize_gradient_direction("linear-gradient(135deg,#fff 0%,#000 100%)");
        assert!(out.starts_with("linear-gradient("));
        // With `135deg` as the current direction, the exclusion logic
        // must pick one of the other three from the four-item pool.
        assert!(
            out.contains("to right")
                || out.contains("to bottom")
                || out.contains("45deg,")
        );
        // And crucially the reroll must not re-select `135deg`.
        assert!(!out.contains("135deg"));
    }

    #[test]
    fn randomize_gradient_direction_passes_solid_through() {
        assert_eq!(randomize_gradient_direction("#ffd800"), "#ffd800");
    }

    #[test]
    fn index_template_has_corner_q_and_footer_controls() {
        let t = theme::ALL.iter().find(|t| t.name == "Trans Pride").unwrap();
        let page = IndexPage {
            theme: t,
            base_domain: "anarchy.lgbt",
            base_domain_json: json_string("anarchy.lgbt"),
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().unwrap();
        // Index-only: rainbow "?" in the top-left corner.
        assert!(html.contains("class=\"corner-q\""));
        // Shared: dice + custom theme picker grouped in the footer.
        assert!(html.contains("footer-left-group"));
        assert!(html.contains("id=\"dice\""));
        assert!(html.contains("id=\"theme-picker\""));
        assert!(html.contains("id=\"theme-picker-button\""));
        assert!(html.contains("id=\"theme-picker-list\""));
        // Footer right: manage link.
        assert!(html.contains("href=\"/m\""));
    }

    #[test]
    fn manage_template_omits_corner_q() {
        let t = theme::ALL.iter().find(|t| t.name == "Trans Pride").unwrap();
        let page = ManagePage {
            theme: t,
            base_domain: "anarchy.lgbt",
            base_domain_json: json_string("anarchy.lgbt"),
            background: randomize_gradient_direction(t.background),
            deco: DecorationView::from_theme(t),
        };
        let html = page.render().unwrap();
        assert!(!html.contains("class=\"corner-q\""));
        assert!(html.contains("href=\"/\""));
    }
}
