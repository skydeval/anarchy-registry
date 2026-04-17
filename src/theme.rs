//! Pride / identity theme catalog.
//!
//! DESIGN.md §6 defines the full theme system. The server picks a random
//! default at render time (askama templates), and `GET /themes` returns
//! this same list as JSON so the client-side dice reroll draws from an
//! identical pool (§4.7 — one source of truth, no drift).
//!
//! The theme catalog is a `const` slice of `Theme` with `&'static str`
//! fields: no allocation, no lazy init, cheap to hand out references.
//!
//! Standard sigil defaults per §6: bottom-right, white, 48px, weight 400,
//! opacity 0.35. Three themes override (Lesbian, Gay, Autism), two use
//! non-sigil decoration (Intersex is a corner badge, DID is undecorated).

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Theme {
    pub name: &'static str,
    pub background: &'static str,
    /// Legacy "bright background" flag from the earlier frosted-glass
    /// shell design (§6) that needed a dark-tinted "fog mode" on
    /// readable backgrounds. The shell is now opaque-dark in every
    /// theme, so this field is always `false` — kept on the struct for
    /// JSON-shape stability of `/themes`, but no code branches on it.
    pub bright: bool,
    pub decoration: Decoration,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Decoration {
    Sigil {
        character: &'static str,
        placement: Placement,
        color: &'static str,
        size_px: u32,
        weight: u32,
        opacity: f32,
    },
    /// Intersex: a yellow/purple SVG ring rendered in a corner. When
    /// `random_corner` is true the client is free to pick a new corner
    /// per render for a subtle animation on reroll.
    CornerBadge {
        random_corner: bool,
    },
    None,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Placement {
    BottomRight,
    TopLeft,
    TopRight,
    BottomLeft,
}

impl Placement {
    /// Inline CSS fragment for a fixed-position element in this corner.
    /// Used by the askama templates to render the sigil position without
    /// introducing placement-specific CSS classes.
    pub fn css(&self) -> &'static str {
        match self {
            Self::BottomRight => "bottom:2rem;right:2rem;",
            Self::TopLeft => "top:2rem;left:2rem;",
            Self::TopRight => "top:2rem;right:2rem;",
            Self::BottomLeft => "bottom:2rem;left:2rem;",
        }
    }
}

// Standard-sigil defaults from §6.
const STD_COLOR: &str = "#ffffff";
const STD_SIZE: u32 = 48;
const STD_WEIGHT: u32 = 400;
const STD_OPACITY: f32 = 0.35;

/// Build a standard-sigil decoration: bottom-right, white, 48px, 400, 0.35.
const fn std_sigil(character: &'static str) -> Decoration {
    Decoration::Sigil {
        character,
        placement: Placement::BottomRight,
        color: STD_COLOR,
        size_px: STD_SIZE,
        weight: STD_WEIGHT,
        opacity: STD_OPACITY,
    }
}

/// The full 21-theme catalog. Order is stable but not semantically meaningful;
/// the client uses `GET /themes` to receive this same list and reroll from it.
pub const ALL: &[Theme] = &[
    Theme {
        name: "Rainbow Pride",
        background: "linear-gradient(135deg,#ff0000 0%,#ff7f00 16%,#ffff00 32%,#00ff00 48%,#0000ff 64%,#4b0082 80%,#8b00ff 100%)",
        bright: false,
        decoration: std_sigil("✺"),
    },
    Theme {
        name: "Trans Pride",
        background: "linear-gradient(135deg,#5bcefa 0%,#5bcefa 10%,#f5a9b8 32%,#ffffff 50%,#f5a9b8 68%,#5bcefa 90%,#5bcefa 100%)",
        bright: false,
        decoration: std_sigil("⚧"),
    },
    Theme {
        name: "Lesbian Pride",
        background: "linear-gradient(135deg,#d52d00 0%,#ef7627 16%,#ff9a56 32%,#ffffff 48%,#d162a4 64%,#b55690 80%,#a30262 100%)",
        bright: false,
        decoration: Decoration::Sigil {
            character: "⚢",
            placement: Placement::BottomRight,
            color: "#fb7185",
            size_px: 36,
            weight: 800,
            opacity: 0.9,
        },
    },
    Theme {
        // MLM flag (Gilbert Baker 2019): green → blue 7-stripe.
        name: "Gay Pride",
        background: "linear-gradient(135deg,#078d70 0%,#26ceaa 16%,#98e8c1 32%,#ffffff 50%,#7bade2 64%,#5049cc 80%,#3d1a78 100%)",
        bright: false,
        decoration: Decoration::Sigil {
            character: "⚣",
            placement: Placement::TopLeft,
            color: "#3b82f6",
            size_px: 30,
            weight: 700,
            opacity: 0.9,
        },
    },
    Theme {
        name: "Nonbinary Pride",
        background: "linear-gradient(135deg,#fff433 0%,#ffffff 25%,#9b59d0 50%,#2c2c2c 75%)",
        bright: false,
        decoration: std_sigil("✧"),
    },
    Theme {
        // Morgan Carpenter 2013: warm gold field, purple ring (see base.html
        // for the SVG stroke colour that matches).
        name: "Intersex",
        background: "#ffd800",
        bright: false,
        decoration: Decoration::CornerBadge { random_corner: true },
    },
    Theme {
        name: "BPD Awareness",
        background: "linear-gradient(135deg,#ff75a2 0%,#ffffff 33%,#7de0c5 66%,#000000 100%)",
        bright: false,
        decoration: std_sigil("♾︎"),
    },
    Theme {
        name: "Dissociation Awareness",
        background: "linear-gradient(135deg,#0f172a 0%,#1e293b 20%,#94a3b8 40%,#f9fafb 55%,#a855f7 75%,#0f172a 100%)",
        bright: false,
        decoration: std_sigil("⧖"),
    },
    Theme {
        name: "Transfemme",
        background: "linear-gradient(135deg,#f5a9b8 0%,#f9d0e5 16%,#ffffff 32%,#c4a5ff 48%,#a855f7 64%,#5bcffa 80%)",
        bright: false,
        decoration: std_sigil("⚧"),
    },
    Theme {
        name: "Transmasc",
        background: "linear-gradient(135deg,#5bcffa 0%,#4f9bd9 16%,#ffffff 32%,#4ade80 48%,#15803d 64%,#0f172a 80%)",
        bright: false,
        decoration: std_sigil("⚧"),
    },
    Theme {
        name: "Genderfluid",
        background: "linear-gradient(135deg,#ff75a2 0%,#ffffff 20%,#be4bdb 40%,#000000 60%,#2b6bff 80%)",
        bright: false,
        decoration: std_sigil("⚨"),
    },
    Theme {
        name: "Asexual",
        background: "linear-gradient(135deg,#000000 0%,#a3a3a3 25%,#ffffff 50%,#810081 75%)",
        bright: false,
        decoration: std_sigil("✕"),
    },
    Theme {
        name: "Aromantic",
        background: "linear-gradient(135deg,#3aa63f 0%,#a7d379 25%,#ffffff 50%,#a9a9a9 75%,#000000 100%)",
        bright: false,
        decoration: std_sigil("❀"),
    },
    Theme {
        // Canonical aroace community flag (2019): orange → yellow → white
        // → light blue → dark blue. Previously used an aromantic/asexual
        // green mashup that matched no adopted flag.
        name: "Aroace",
        background: "linear-gradient(135deg,#e28c00 0%,#eccd00 25%,#ffffff 50%,#62aedc 75%,#203856 100%)",
        bright: false,
        decoration: std_sigil("❁"),
    },
    Theme {
        name: "Autism",
        background: "linear-gradient(135deg,#ff9f1c 0%,#ff595e 20%,#ffca3a 40%,#8ac926 60%,#1982c4 80%,#6a4c93 100%)",
        bright: false,
        decoration: Decoration::Sigil {
            character: "∞",
            placement: Placement::TopRight,
            color: "#ffdd00",
            size_px: 38,
            weight: 800,
            opacity: 0.9,
        },
    },
    Theme {
        name: "Plural",
        background: "linear-gradient(135deg,#3f1a6b 0%,#6e3fa8 18%,#ffffff 50%,#4fa86b 82%,#1f5a32 100%)",
        bright: false,
        decoration: std_sigil("⚯"),
    },
    Theme {
        name: "DID",
        background: "linear-gradient(135deg,#020617 0%,#111827 25%,#312e81 50%,#6d28d9 75%,#f472b6 100%)",
        bright: false,
        decoration: Decoration::None,
    },
    Theme {
        name: "OSDD",
        background: "linear-gradient(135deg,#020617 0%,#1f2937 20%,#4b5563 40%,#6366f1 65%,#a855f7 100%)",
        bright: false,
        decoration: std_sigil("⟁"),
    },
    Theme {
        name: "Depersonalization",
        background: "linear-gradient(135deg,#0f172a 0%,#1f2937 18%,#e5e7eb 45%,#c4b5fd 70%,#f9a8d4 100%)",
        bright: false,
        decoration: std_sigil("◌"),
    },
    Theme {
        name: "Derealization",
        background: "linear-gradient(135deg,#020617 0%,#111827 30%,#22c55e 55%,#38bdf8 75%,#f97316 100%)",
        bright: false,
        decoration: std_sigil("⌬"),
    },
    Theme {
        name: "Polyamory",
        background: "linear-gradient(135deg,#0057B7 0%,#0057B7 24%,#D62828 40%,#D62828 72%,#000000 100%)",
        bright: false,
        decoration: std_sigil("∞❤"),
    },
];

/// Uniformly pick a theme for server-side render.
pub fn pick_random() -> &'static Theme {
    use rand::seq::SliceRandom;
    ALL.choose(&mut rand::thread_rng())
        .expect("theme catalog is non-empty")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_all_21_themes_from_design() {
        assert_eq!(ALL.len(), 21);
    }

    #[test]
    fn theme_names_are_unique() {
        let mut names: Vec<&str> = ALL.iter().map(|t| t.name).collect();
        names.sort();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "duplicate theme name");
    }

    #[test]
    fn custom_sigil_themes_match_design_table() {
        let check = |name: &str, want_color: &str, want_size: u32, want_weight: u32, want_opacity: f32, want_place: &str| {
            let t = ALL.iter().find(|t| t.name == name).expect("missing theme");
            match t.decoration {
                Decoration::Sigil { color, size_px, weight, opacity, placement, .. } => {
                    assert_eq!(color, want_color, "{name} color");
                    assert_eq!(size_px, want_size, "{name} size");
                    assert_eq!(weight, want_weight, "{name} weight");
                    assert!((opacity - want_opacity).abs() < 1e-6, "{name} opacity");
                    let got = format!("{placement:?}");
                    assert!(got.eq_ignore_ascii_case(want_place), "{name} placement got {got}");
                }
                _ => panic!("{name} should be Sigil"),
            }
        };
        check("Lesbian Pride", "#fb7185", 36, 800, 0.9, "BottomRight");
        check("Gay Pride", "#3b82f6", 30, 700, 0.9, "TopLeft");
        check("Autism", "#ffdd00", 38, 800, 0.9, "TopRight");
    }

    #[test]
    fn intersex_is_corner_badge_and_did_is_undecorated() {
        let intersex = ALL.iter().find(|t| t.name == "Intersex").unwrap();
        assert!(matches!(intersex.decoration, Decoration::CornerBadge { .. }));
        let did = ALL.iter().find(|t| t.name == "DID").unwrap();
        assert!(matches!(did.decoration, Decoration::None));
    }

    #[test]
    fn no_theme_is_bright_after_opaque_shell_rework() {
        // The opaque-dark shell is readable on every background, so the
        // bright/fog distinction from the original §6 design no longer
        // applies. Encoded as an invariant so a future theme addition
        // can't accidentally reintroduce a dead flag state.
        assert!(ALL.iter().all(|t| !t.bright));
    }

    #[test]
    fn serializes_to_design_shape() {
        let trans = ALL.iter().find(|t| t.name == "Trans Pride").unwrap();
        let v = serde_json::to_value(trans).unwrap();
        // §5 example fields
        assert_eq!(v["name"], "Trans Pride");
        assert_eq!(v["bright"], false);
        assert_eq!(v["decoration"]["type"], "sigil");
        assert_eq!(v["decoration"]["character"], "⚧");
        assert_eq!(v["decoration"]["placement"], "bottom-right");
        assert_eq!(v["decoration"]["color"], "#ffffff");
        assert_eq!(v["decoration"]["size_px"], 48);
        assert_eq!(v["decoration"]["weight"], 400);
        // f32 -> JSON widens imprecisely; compare within tolerance.
        let opacity = v["decoration"]["opacity"].as_f64().unwrap();
        assert!((opacity - 0.35).abs() < 1e-6);
    }

    #[test]
    fn corner_badge_and_none_serialize_with_type_tag() {
        let intersex = ALL.iter().find(|t| t.name == "Intersex").unwrap();
        let v = serde_json::to_value(intersex).unwrap();
        assert_eq!(v["decoration"]["type"], "corner-badge");
        assert_eq!(v["decoration"]["random_corner"], true);

        let did = ALL.iter().find(|t| t.name == "DID").unwrap();
        let v = serde_json::to_value(did).unwrap();
        assert_eq!(v["decoration"]["type"], "none");
    }

    #[test]
    fn pick_random_returns_catalog_member() {
        let t = pick_random();
        assert!(ALL.iter().any(|c| c.name == t.name));
    }
}
