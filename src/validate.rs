//! Input validation and normalization.
//!
//! DESIGN.md §7 enumerates the subdomain rules (stricter than the original
//! worker, which only enforced length + character class):
//!
//! - 4–40 chars
//! - character class `[a-z0-9-]`
//! - no leading or trailing hyphen
//! - no consecutive hyphens (this is also what blocks punycode: the IDN
//!   form is always `xn--…`, so the double-hyphen rule subsumes the
//!   explicit punycode rule from §7)
//! - no unicode invisibles (zero-width spaces, RTL marks, etc.) — handled
//!   implicitly by the ASCII gate before the byte-level checks
//!
//! §3 specifies that subdomains, DIDs, pds hosts, and keywords are all
//! lowercased on insert. The `normalize_*` helpers produce the canonical
//! form; `is_valid_*` checks the already-normalized form.

/// Trim and lowercase the subdomain. The ASCII-ness of the result is not
/// guaranteed — `is_valid_subdomain` is the gate for that.
pub fn normalize_subdomain(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

/// Validate an already-normalized subdomain against the §7 rules.
pub fn is_valid_subdomain(sub: &str) -> bool {
    let len = sub.len();
    if !(4..=40).contains(&len) {
        return false;
    }

    // Non-ASCII catches unicode invisibles, RTL marks, fullwidth variants,
    // homoglyphs, and anything that might survive case-folding oddly.
    if !sub.is_ascii() {
        return false;
    }

    let bytes = sub.as_bytes();

    if bytes[0] == b'-' || bytes[len - 1] == b'-' {
        return false;
    }

    let mut prev_hyphen = false;
    for &b in bytes {
        let in_class = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
        if !in_class {
            return false;
        }
        let is_hyphen = b == b'-';
        if is_hyphen && prev_hyphen {
            return false;
        }
        prev_hyphen = is_hyphen;
    }

    true
}

/// Trim + lowercase per §3. DIDs in practice (did:plc:, did:web:) are
/// lowercase or case-insensitive at the parts we touch; lowercasing gives
/// a single canonical form for lookup.
pub fn normalize_did(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

/// A DID is `did:<method>:<id>` where method is lowercase ASCII and id is
/// non-empty. This is the bare minimum shape check — the real proof a DID
/// is usable is whether it resolves, which lives in `atproto.rs`.
pub fn is_valid_did(did: &str) -> bool {
    if did.is_empty() || did.len() > 256 || !did.is_ascii() {
        return false;
    }
    let rest = match did.strip_prefix("did:") {
        Some(r) => r,
        None => return false,
    };
    let (method, id) = match rest.split_once(':') {
        Some(pair) => pair,
        None => return false,
    };
    if method.is_empty() || id.is_empty() {
        return false;
    }
    method
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Trim + lowercase a PDS hostname. Admin blocklist input path.
pub fn normalize_pds_host(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

/// Hostname-ish check: ASCII, 1–253 chars, labels of 1–63 chars from
/// `[a-z0-9-]` with no leading/trailing hyphen per label. Not a full RFC
/// 1035 parser — admins supply these, and the network is the final arbiter.
pub fn is_valid_pds_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || !host.is_ascii() {
        return false;
    }
    host.split('.').all(|label| {
        let len = label.len();
        if !(1..=63).contains(&len) {
            return false;
        }
        let b = label.as_bytes();
        if b[0] == b'-' || b[len - 1] == b'-' {
            return false;
        }
        b.iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    })
}

/// Keywords are operator-supplied substrings matched against subdomains,
/// so they live in the subdomain alphabet. Normalize and bound length.
pub fn normalize_keyword(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

pub fn is_valid_keyword(kw: &str) -> bool {
    let len = kw.len();
    (1..=40).contains(&len)
        && kw.is_ascii()
        && kw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdomain_length_bounds() {
        assert!(!is_valid_subdomain("abc"));
        assert!(is_valid_subdomain("abcd"));
        assert!(is_valid_subdomain(&"a".repeat(40)));
        assert!(!is_valid_subdomain(&"a".repeat(41)));
    }

    #[test]
    fn subdomain_character_class() {
        assert!(is_valid_subdomain("alice"));
        assert!(is_valid_subdomain("a1b2"));
        assert!(is_valid_subdomain("a-b-c"));
        assert!(!is_valid_subdomain("Alice"));
        assert!(!is_valid_subdomain("alice_foo"));
        assert!(!is_valid_subdomain("alice.foo"));
    }

    #[test]
    fn subdomain_hyphen_rules() {
        assert!(!is_valid_subdomain("-alice"));
        assert!(!is_valid_subdomain("alice-"));
        assert!(!is_valid_subdomain("a--b"));
        // xn-- punycode form is caught by the double-hyphen rule:
        assert!(!is_valid_subdomain("xn--abc"));
    }

    #[test]
    fn subdomain_rejects_unicode_invisibles() {
        // zero-width space U+200B inside an otherwise valid label
        assert!(!is_valid_subdomain("ali\u{200B}ce"));
        // cyrillic 'а' (homoglyph)
        assert!(!is_valid_subdomain("аlice"));
    }

    #[test]
    fn subdomain_normalize_lowercases_and_trims() {
        assert_eq!(normalize_subdomain("  Alice  "), "alice");
    }

    #[test]
    fn did_shape() {
        assert!(is_valid_did("did:plc:abc123"));
        assert!(is_valid_did("did:web:example.com"));
        assert!(!is_valid_did("plc:abc"));
        assert!(!is_valid_did("did::abc"));
        assert!(!is_valid_did("did:plc:"));
        assert!(!is_valid_did("did:Plc:abc"));
    }

    #[test]
    fn pds_host_shape() {
        assert!(is_valid_pds_host("bsky.social"));
        assert!(is_valid_pds_host("pds.anarchy.lgbt"));
        assert!(!is_valid_pds_host(""));
        assert!(!is_valid_pds_host("bsky..social"));
        assert!(!is_valid_pds_host("-bsky.social"));
        assert!(!is_valid_pds_host("BSKY.SOCIAL"));
    }

    #[test]
    fn keyword_shape() {
        assert!(is_valid_keyword("slur"));
        assert!(!is_valid_keyword(""));
        assert!(!is_valid_keyword(&"a".repeat(41)));
        assert!(!is_valid_keyword("Slur"));
    }
}
