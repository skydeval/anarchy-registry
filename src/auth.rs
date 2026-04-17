//! Authentication primitives.
//!
//! Three concerns covered here (all grounded in DESIGN.md §4.1/§4.2/§4.4):
//!
//! 1. **User secret keys** — 24-char tokens from a 31-char alphabet, so
//!    ~119 bits of entropy. Stored as SHA-256 hex and verified in constant
//!    time. SHA-256 is deliberate (§4.1): argon2id's cost-per-guess
//!    protection targets low-entropy passwords; brute-forcing 119 bits is
//!    already computationally infeasible against *any* reasonable hash, so
//!    paying argon2id's 50-100 ms per auth would buy nothing.
//!
//! 2. **Admin password** — human-chosen, realistic entropy 40-80 bits.
//!    This is exactly the threat model argon2id was built for. We store
//!    the PHC-encoded hash (parameters embedded in the string) and verify
//!    via the argon2 crate's constant-time path.
//!
//! 3. **Session + CSRF** (§4.4) — the session cookie is `payload.mac(payload)`
//!    where `payload` carries a fresh 128-bit session id and a unix expiry.
//!    HMAC-SHA256 over `ADMIN_SESSION_SECRET`. CSRF token is a separate
//!    HMAC derivation over the session id — deterministic per session, so
//!    no server-side store is needed, and forging either requires the
//!    session secret.

use argon2::password_hash::{SaltString, rand_core::OsRng};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use hmac::{Hmac, Mac};
use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::{AppError, AppResult};

type HmacSha256 = Hmac<Sha256>;

// ------------------------------------------------------------------
// user secret keys (§4.1 — SHA-256, unchanged from worker)
// ------------------------------------------------------------------

pub const USER_SECRET_LEN: usize = 24;
/// 31 chars: lowercase letters minus `i`, `l`, `o`, and digits 2-9
/// (drops 0/1 to avoid homoglyphs). Matches the worker's alphabet so
/// the cutover's imported hashes continue to verify byte-for-byte.
pub const USER_SECRET_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

pub fn generate_user_secret() -> String {
    let mut rng = rand::thread_rng();
    (0..USER_SECRET_LEN)
        .map(|_| {
            let idx = rng.gen_range(0..USER_SECRET_ALPHABET.len());
            USER_SECRET_ALPHABET[idx] as char
        })
        .collect()
}

pub fn hash_user_secret(secret: &str) -> String {
    let mut h = Sha256::new();
    h.update(secret.as_bytes());
    hex::encode(h.finalize())
}

/// Constant-time verify. Hashing the input first means a timing-channel
/// attacker can't craft inputs whose byte-by-byte comparison against the
/// stored hash leaks a prefix match — the SHA-256 output diffuses any
/// correlation between attacker input and final byte pattern.
pub fn verify_user_secret(input: &str, stored_hex: &str) -> bool {
    let input_hash = hash_user_secret(input);
    ct_eq_str(&input_hash, stored_hex)
}

// ------------------------------------------------------------------
// admin password (§4.1 — argon2id)
// ------------------------------------------------------------------

/// Produces a PHC-format string (`$argon2id$...`) with parameters
/// embedded. Safe to store directly in config. Only called at setup
/// time / admin rotation, not on every request.
pub fn hash_admin_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Internal(format!("argon2 hash failed: {e}")))
}

/// `false` on any failure: wrong password, malformed PHC, argon2 error.
/// The non-enumeration policy (§4.3) collapses all of these into one
/// observable response anyway, so conflating them here is intentional.
pub fn verify_admin_password(input: &str, stored_phc: &str) -> bool {
    let parsed = match PasswordHash::new(stored_phc) {
        Ok(p) => p,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(input.as_bytes(), &parsed)
        .is_ok()
}

// ------------------------------------------------------------------
// session cookies (§4.4)
// ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub session_id: [u8; 16],
    /// Unix timestamp (seconds). Past-expiry sessions are rejected by
    /// `parse_session` without needing to decode further.
    pub expires_at: i64,
}

/// Issue a fresh session valid for `ttl_seconds`. Returns the `Session`
/// (for CSRF derivation + logging) and the cookie value to send.
pub fn issue_session(secret: &[u8], ttl_seconds: i64) -> (Session, String) {
    let mut session_id = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut session_id);
    let expires_at = chrono::Utc::now().timestamp() + ttl_seconds;
    let session = Session { session_id, expires_at };
    let cookie = sign_session(secret, &session);
    (session, cookie)
}

/// Verify the MAC, decode the payload, check the expiry. All-or-nothing:
/// any failure returns `None` with no distinguishable signal.
pub fn parse_session(secret: &[u8], cookie_value: &str) -> Option<Session> {
    let (payload, sig_hex) = cookie_value.rsplit_once('.')?;
    let sig = hex::decode(sig_hex).ok()?;

    let mut mac = HmacSha256::new_from_slice(secret).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&sig).ok()?;

    let (expires_str, id_hex) = payload.split_once(':')?;
    let expires_at: i64 = expires_str.parse().ok()?;
    if expires_at < chrono::Utc::now().timestamp() {
        return None;
    }
    let id_bytes = hex::decode(id_hex).ok()?;
    if id_bytes.len() != 16 {
        return None;
    }
    let mut session_id = [0u8; 16];
    session_id.copy_from_slice(&id_bytes);
    Some(Session { session_id, expires_at })
}

fn sign_session(secret: &[u8], s: &Session) -> String {
    let payload = format!("{}:{}", s.expires_at, hex::encode(s.session_id));
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key size");
    mac.update(payload.as_bytes());
    let sig = mac.finalize().into_bytes();
    format!("{}.{}", payload, hex::encode(sig))
}

// ------------------------------------------------------------------
// CSRF tokens (§4.4 — defense-in-depth; SameSite=Lax is the primary)
// ------------------------------------------------------------------

/// Deterministic derivation: `HMAC(secret, session_id || "csrf")`. Same
/// token for the lifetime of a session, different across sessions, and
/// unforgeable without the session secret — so there's nothing to store
/// server-side and nothing to rotate separately.
pub fn csrf_token_for(secret: &[u8], session: &Session) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key size");
    mac.update(&session.session_id);
    mac.update(b"csrf");
    hex::encode(mac.finalize().into_bytes())
}

pub fn verify_csrf(secret: &[u8], session: &Session, token: &str) -> bool {
    ct_eq_str(&csrf_token_for(secret, session), token)
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

fn ct_eq_str(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- user secrets ---

    #[test]
    fn user_secret_has_correct_shape() {
        for _ in 0..50 {
            let s = generate_user_secret();
            assert_eq!(s.len(), USER_SECRET_LEN);
            assert!(s.bytes().all(|b| USER_SECRET_ALPHABET.contains(&b)));
        }
    }

    #[test]
    fn user_secret_hash_is_deterministic() {
        assert_eq!(hash_user_secret("hello"), hash_user_secret("hello"));
        assert_ne!(hash_user_secret("hello"), hash_user_secret("world"));
        assert_eq!(hash_user_secret("hello").len(), 64);
    }

    #[test]
    fn user_secret_verify_matches_and_rejects() {
        let secret = generate_user_secret();
        let stored = hash_user_secret(&secret);
        assert!(verify_user_secret(&secret, &stored));
        assert!(!verify_user_secret("wrong-secret", &stored));
        assert!(!verify_user_secret(&secret, "not-even-a-hash"));
        assert!(!verify_user_secret(&secret, ""));
    }

    // --- admin password ---

    #[test]
    fn admin_password_roundtrip() {
        let phc = hash_admin_password("hunter2").unwrap();
        assert!(phc.starts_with("$argon2"));
        assert!(verify_admin_password("hunter2", &phc));
        assert!(!verify_admin_password("hunter3", &phc));
    }

    #[test]
    fn admin_password_rejects_malformed_phc() {
        assert!(!verify_admin_password("any", "not-a-phc-string"));
        assert!(!verify_admin_password("any", ""));
    }

    // --- session ---

    #[test]
    fn session_roundtrip() {
        let secret = b"test-session-secret-0123456789";
        let (issued, cookie) = issue_session(secret, 3600);
        let parsed = parse_session(secret, &cookie).expect("round-trips");
        assert_eq!(parsed, issued);
    }

    #[test]
    fn session_rejects_tampered_payload() {
        let secret = b"test-session-secret-0123456789";
        let (_, cookie) = issue_session(secret, 3600);
        // Flip a byte in the payload (before the signature dot).
        let (payload, sig) = cookie.rsplit_once('.').unwrap();
        let mut bytes = payload.as_bytes().to_vec();
        bytes[0] ^= 0x01;
        let tampered = format!("{}.{}", String::from_utf8(bytes).unwrap(), sig);
        assert!(parse_session(secret, &tampered).is_none());
    }

    #[test]
    fn session_rejects_wrong_secret() {
        let (_, cookie) = issue_session(b"key-a-0123456789012345678901234", 3600);
        assert!(parse_session(b"key-b-0123456789012345678901234", &cookie).is_none());
    }

    #[test]
    fn session_rejects_expired() {
        let secret = b"test-session-secret-0123456789";
        // Negative TTL — produces a session already past expiry.
        let (_, cookie) = issue_session(secret, -60);
        assert!(parse_session(secret, &cookie).is_none());
    }

    #[test]
    fn session_rejects_garbage() {
        let secret = b"test-session-secret-0123456789";
        for junk in ["", ".", "abc.def", "xxx", "1:ff.ff"] {
            assert!(parse_session(secret, junk).is_none(), "accepted {junk:?}");
        }
    }

    // --- CSRF ---

    #[test]
    fn csrf_is_deterministic_per_session_and_unique_across() {
        let secret = b"session-secret";
        let (s1, _) = issue_session(secret, 3600);
        let (s2, _) = issue_session(secret, 3600);
        let t1a = csrf_token_for(secret, &s1);
        let t1b = csrf_token_for(secret, &s1);
        let t2 = csrf_token_for(secret, &s2);
        assert_eq!(t1a, t1b);
        assert_ne!(t1a, t2);
    }

    #[test]
    fn csrf_verify_matches_and_rejects() {
        let secret = b"session-secret";
        let (session, _) = issue_session(secret, 3600);
        let token = csrf_token_for(secret, &session);
        assert!(verify_csrf(secret, &session, &token));
        assert!(!verify_csrf(secret, &session, "deadbeef"));
        assert!(!verify_csrf(b"other-secret", &session, &token));
    }
}
