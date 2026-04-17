//! Embedded list of common English words. Used by the admin
//! `/preview-keyword` endpoint to surface likely false-positives
//! *before* an operator commits a substring to the blocklist:
//! blocking `"nig"` will also reject `"knight"`, `"benign"`, etc.,
//! and the operator deserves to see that up front.
//!
//! The list lives in `data/common_words.txt` (one lowercase word per
//! line, no duplicates) and is embedded into the binary at compile
//! time via `include_str!`. Swap in a larger corpus whenever — the
//! module surface stays the same.

const RAW: &str = include_str!("../data/common_words.txt");

/// Result of a substring scan over the embedded word list.
#[derive(Debug, Clone)]
pub struct PreviewResult {
    /// Up to `limit` matching words, in the order they appear in the
    /// underlying list (alphabetical, as the file is sorted).
    pub matches: Vec<&'static str>,
    /// Total number of matching words before truncation to `limit`.
    /// Useful for reporting "showing 30 of 147" to the operator.
    pub total: usize,
}

/// Scan the embedded list for every word containing `substring` as a
/// substring (case-sensitive — caller should pre-lowercase to match the
/// lowercase file).
///
/// Returns at most `limit` matches plus the full total, so callers can
/// show "N more" without loading everything into the UI.
pub fn matching(substring: &str, limit: usize) -> PreviewResult {
    let sub = substring.trim();
    if sub.is_empty() {
        return PreviewResult { matches: Vec::new(), total: 0 };
    }
    let mut total = 0usize;
    let mut matches: Vec<&'static str> = Vec::new();
    for word in RAW.lines() {
        if word.is_empty() {
            continue;
        }
        if word.contains(sub) {
            total += 1;
            if matches.len() < limit {
                matches.push(word);
            }
        }
    }
    PreviewResult { matches, total }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_no_matches() {
        let r = matching("", 10);
        assert!(r.matches.is_empty());
        assert_eq!(r.total, 0);
    }

    #[test]
    fn finds_the_very_substring_itself() {
        // The word "night" is in the canonical common-word list.
        let r = matching("night", 10);
        assert!(r.matches.iter().any(|w| *w == "night"));
    }

    #[test]
    fn surfaces_false_positive_style_matches() {
        // Classic false-positive example: blocking "nig" would also
        // reject legitimate English words. Verify the feature catches
        // at least one of the common ones from the embedded list.
        let r = matching("nig", 50);
        let joined: Vec<&str> = r.matches.iter().copied().collect();
        assert!(
            joined.iter().any(|w| *w == "night")
                || joined.iter().any(|w| *w == "knight")
                || joined.iter().any(|w| *w == "benign"),
            "preview('nig') should surface at least one of night/knight/benign; got {joined:?}"
        );
    }

    #[test]
    fn truncates_to_limit_and_reports_total() {
        // Very common two-letter substring is guaranteed to exceed a
        // small limit on any reasonable list.
        let r = matching("e", 5);
        assert_eq!(r.matches.len(), 5);
        assert!(r.total >= 5);
    }

    #[test]
    fn unmatched_substring_returns_empty() {
        // A junk string with no hits — total stays 0.
        let r = matching("qzxzqzxz", 10);
        assert_eq!(r.matches.len(), 0);
        assert_eq!(r.total, 0);
    }
}
