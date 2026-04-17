//! External atproto calls: handle → DID, DID → PDS host.
//!
//! Two upstreams:
//!
//! - `https://bsky.social/xrpc/com.atproto.identity.resolveHandle` turns a
//!   bluesky handle (e.g. `alice.bsky.social`) into a DID.
//! - `https://plc.directory/{did}` returns the DID document, from which
//!   we extract the PDS hostname to feed the blocklist check.
//!
//! The endpoints are injectable via `with_endpoints` so integration
//! tests can point at a wiremock/httpmock server without touching the
//! real PLC or appview.
//!
//! Every method returns `Option` (not `AppResult`): callers treat *any*
//! failure — network error, 404, malformed JSON, missing services — as
//! "couldn't resolve". That maps to `AppError::UnresolvableBlueskyHandle`
//! at the service layer per DESIGN.md §5, and to `None` for PDS lookups
//! where the operator just doesn't learn the PDS (registration proceeds
//! without a blocklist check against it).

use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

// ------------------------------------------------------------------
// client
// ------------------------------------------------------------------

#[derive(Clone)]
pub struct AtprotoClient {
    http: Client,
    bsky_appview: String,
    plc_directory: String,
}

impl AtprotoClient {
    /// Production defaults pointing at bsky.social + plc.directory.
    pub fn new() -> Self {
        Self::with_endpoints(
            "https://bsky.social".to_string(),
            "https://plc.directory".to_string(),
        )
    }

    pub fn with_endpoints(bsky_appview: String, plc_directory: String) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("anarchy-registry/0.1")
            .build()
            .expect("reqwest Client build should not fail with default TLS");
        Self {
            http,
            bsky_appview,
            plc_directory,
        }
    }

    /// Resolve a handle to a DID. Accepts:
    /// - a DID as-is (returned unchanged)
    /// - a handle, with or without a leading `@`
    /// - any casing (lowercased before lookup)
    ///
    /// None means "couldn't determine a DID" for any reason.
    pub async fn resolve_handle(&self, handle: &str) -> Option<String> {
        let input = normalize_handle_input(handle);
        if input.starts_with("did:") {
            return Some(input);
        }
        let url = format!(
            "{}/xrpc/com.atproto.identity.resolveHandle?handle={}",
            self.bsky_appview,
            urlencode(&input),
        );
        let resp = self.http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: ResolveHandleResponse = resp.json().await.ok()?;
        Some(body.did)
    }

    /// Look up the PDS hostname for a `did:plc:` via the PLC directory.
    /// Non-plc DIDs short-circuit to None — we don't support plc-web /
    /// did:web resolution in v1.
    pub async fn resolve_pds_host(&self, did: &str) -> Option<String> {
        if !did.starts_with("did:plc:") {
            return None;
        }
        let url = format!("{}/{}", self.plc_directory, urlencode(did));
        let resp = self.http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let doc: PlcDoc = resp.json().await.ok()?;
        pick_pds_host(&doc)
    }
}

impl Default for AtprotoClient {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------------------------------------------------
// helpers + parsing
// ------------------------------------------------------------------

fn normalize_handle_input(raw: &str) -> String {
    raw.trim().trim_start_matches('@').to_ascii_lowercase()
}

/// Minimal URL-encode for the query-string values we pass. We only ever
/// feed it a bluesky handle or a DID, both of which use a restricted
/// character set, so a hand-rolled encoder is enough — no pulling in
/// another crate for this.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let ok = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b':');
        if ok {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Deserialize)]
struct ResolveHandleResponse {
    did: String,
}

#[derive(Deserialize)]
struct PlcDoc {
    #[serde(default)]
    service: Vec<PlcService>,
}

#[derive(Deserialize)]
struct PlcService {
    #[serde(rename = "type", default)]
    svc_type: String,
    #[serde(rename = "serviceEndpoint", alias = "endpoint", default)]
    endpoint: String,
}

/// Extract a PDS hostname from a PLC DID document.
///
/// 1. Prefer the first service whose `type` identifies it as the atproto
///    PDS. The canonical value is `AtprotoPersonalDataServer` (lowercases
///    to contain `"personaldataserver"`); we also accept any variant with
///    a literal `"pds"` substring for forward-compat with shorter forms.
/// 2. Otherwise, fall back to the first service with a parseable URL —
///    PLC docs in practice contain exactly one service, so this is the
///    quiet correct answer when the type isn't recognized.
fn pick_pds_host(doc: &PlcDoc) -> Option<String> {
    for svc in &doc.service {
        let t = svc.svc_type.to_ascii_lowercase();
        let is_pds =
            t.contains("atproto") && (t.contains("personaldataserver") || t.contains("pds"));
        if is_pds {
            if let Some(host) = hostname_of(&svc.endpoint) {
                return Some(host);
            }
        }
    }
    for svc in &doc.service {
        if let Some(host) = hostname_of(&svc.endpoint) {
            return Some(host);
        }
    }
    None
}

/// Extract the host from a URL like `https://host[:port][/path...]`.
/// Avoids a dedicated URL crate for a parser that only has to handle the
/// shapes PLC returns in its `serviceEndpoint` field.
fn hostname_of(endpoint: &str) -> Option<String> {
    let after_scheme = endpoint.split_once("://")?.1;
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = host.split(':').next()?;
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

// ------------------------------------------------------------------
// tests
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_at_and_lowercases() {
        assert_eq!(normalize_handle_input("@Alice.Bsky.Social"), "alice.bsky.social");
        assert_eq!(normalize_handle_input("  alice  "), "alice");
        assert_eq!(normalize_handle_input("did:plc:ABC"), "did:plc:abc");
    }

    #[test]
    fn urlencode_preserves_safe_chars_and_percent_encodes_others() {
        assert_eq!(urlencode("alice.bsky.social"), "alice.bsky.social");
        assert_eq!(urlencode("did:plc:abc123"), "did:plc:abc123");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("a/b"), "a%2Fb");
    }

    #[test]
    fn pick_pds_host_prefers_atproto_pds_service() {
        let doc = PlcDoc {
            service: vec![
                PlcService {
                    svc_type: "AtprotoLabeler".into(),
                    endpoint: "https://labeler.example/".into(),
                },
                PlcService {
                    svc_type: "AtprotoPersonalDataServer".into(),
                    endpoint: "https://pds.bsky.social/".into(),
                },
            ],
        };
        assert_eq!(pick_pds_host(&doc).as_deref(), Some("pds.bsky.social"));
    }

    #[test]
    fn pick_pds_host_falls_back_to_first_parseable() {
        let doc = PlcDoc {
            service: vec![PlcService {
                svc_type: "SomethingElse".into(),
                endpoint: "https://first.example/".into(),
            }],
        };
        assert_eq!(pick_pds_host(&doc).as_deref(), Some("first.example"));
    }

    #[test]
    fn hostname_of_handles_various_shapes() {
        assert_eq!(hostname_of("https://pds.bsky.social/").as_deref(), Some("pds.bsky.social"));
        assert_eq!(hostname_of("https://Pds.Bsky.Social").as_deref(), Some("pds.bsky.social"));
        assert_eq!(hostname_of("https://host:8443/x").as_deref(), Some("host"));
        assert_eq!(hostname_of("https://user@host/").as_deref(), Some("host"));
        assert_eq!(hostname_of("not a url"), None);
        assert_eq!(hostname_of("https:///path"), None);
    }

    #[test]
    fn pick_pds_host_skips_unparseable_endpoints() {
        let doc = PlcDoc {
            service: vec![
                PlcService {
                    svc_type: "AtprotoPersonalDataServer".into(),
                    endpoint: "not a url".into(),
                },
                PlcService {
                    svc_type: "AtprotoPersonalDataServer".into(),
                    endpoint: "https://real.pds/".into(),
                },
            ],
        };
        assert_eq!(pick_pds_host(&doc).as_deref(), Some("real.pds"));
    }

    #[test]
    fn pick_pds_host_returns_none_on_empty_services() {
        let doc = PlcDoc { service: vec![] };
        assert!(pick_pds_host(&doc).is_none());
    }

    #[test]
    fn plc_doc_deserializes_from_real_shape() {
        let body = r##"{
            "@context": ["https://www.w3.org/ns/did/v1"],
            "id": "did:plc:abc",
            "alsoKnownAs": ["at://alice.bsky.social"],
            "service": [
                {
                    "id": "#atproto_pds",
                    "type": "AtprotoPersonalDataServer",
                    "serviceEndpoint": "https://morel.us-east.host.bsky.network"
                }
            ]
        }"##;
        let doc: PlcDoc = serde_json::from_str(body).unwrap();
        assert_eq!(
            pick_pds_host(&doc).as_deref(),
            Some("morel.us-east.host.bsky.network")
        );
    }

    #[test]
    fn resolve_handle_response_deserializes() {
        let body = r#"{"did":"did:plc:abc123"}"#;
        let r: ResolveHandleResponse = serde_json::from_str(body).unwrap();
        assert_eq!(r.did, "did:plc:abc123");
    }
}
