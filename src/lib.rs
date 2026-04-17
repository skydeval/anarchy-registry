//! anarchy.lgbt registry — library crate.
//!
//! The binary entry point at `src/main.rs` is deliberately thin: it loads
//! configuration, wires the layers below, and starts the axum server.
//! Everything else — the layered implementation from DESIGN.md §4.6 —
//! lives here so integration tests under `tests/` can exercise the full
//! stack via the crate's public API.

pub mod atproto;
pub mod auth;
pub mod db;
pub mod error;
pub mod handlers;
pub mod rate_limit;
pub mod routes;
pub mod service;
pub mod theme;
pub mod validate;
