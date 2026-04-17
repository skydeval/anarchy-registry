//! Service entry point. Reads configuration from env (or an optional
//! `.env` via dotenvy), wires the layered components into an axum server,
//! and binds on `LISTEN_ADDR`. Deployment shape is in DESIGN.md §8.
//!
//! All substance lives in the `anarchy_registry` library crate so
//! integration tests can exercise it directly; this binary is only the
//! config/startup shell.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use anarchy_registry::atproto::AtprotoClient;
use anarchy_registry::auth;
use anarchy_registry::handlers::{AdminConfig, AppState};
use anarchy_registry::rate_limit::RateLimiter;
use anarchy_registry::service::Service;
use anarchy_registry::{db, routes};

const SESSION_TTL_SECONDS: i64 = 8 * 60 * 60;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // One-shot utility: `anarchy-registry --hash-password <pw>` prints
    // an argon2id PHC string for `ADMIN_PASSWORD_HASH` and exits. Runs
    // before any env/db/tracing setup so operators can use the binary
    // without needing a filled-in environment.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--hash-password") {
        let pw = args.get(2).ok_or_else(|| {
            anyhow::anyhow!("usage: anarchy-registry --hash-password <password>")
        })?;
        let hash = auth::hash_admin_password(pw)
            .map_err(|e| anyhow::anyhow!("hashing failed: {e}"))?;
        println!("{hash}");
        return Ok(());
    }

    // `.env` is optional in production (systemd sources `EnvironmentFile`
    // per §8); we still try here for local runs.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cfg = Config::from_env()?;
    info!(
        listen = %cfg.listen_addr,
        base_domain = %cfg.base_domain,
        "starting anarchy-registry"
    );

    let pool = db::connect(&cfg.database_url)
        .await
        .map_err(|e| anyhow::anyhow!("db::connect: {e}"))?;

    let rate_limiter = RateLimiter::new(pool.clone(), cfg.trusted_ips.clone());
    let service = Arc::new(Service::new(
        pool.clone(),
        AtprotoClient::new(),
        rate_limiter.clone(),
        cfg.base_domain.clone(),
    ));

    let state = AppState {
        service,
        rate_limiter,
        admin: AdminConfig {
            path: Arc::from(cfg.admin_path),
            password_hash: Arc::from(cfg.admin_password_hash),
            session_secret: Arc::from(cfg.admin_session_secret.into_boxed_slice()),
            session_ttl_seconds: SESSION_TTL_SECONDS,
        },
        base_domain: Arc::from(cfg.base_domain),
    };

    // Background sweep for expired rate-limit buckets. Loses data on
    // restart (acceptable — buckets are ephemeral by design).
    tokio::spawn({
        let rl = state.rate_limiter.clone();
        async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60 * 15));
            loop {
                tick.tick().await;
                match rl.sweep().await {
                    Ok(n) if n > 0 => info!(removed = n, "rate-limit sweep"),
                    Ok(_) => {}
                    Err(e) => warn!(error = %e, "rate-limit sweep failed"),
                }
            }
        }
    });

    let app = routes::build(state);
    let listener = TcpListener::bind(cfg.listen_addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

// ------------------------------------------------------------------
// config
// ------------------------------------------------------------------

struct Config {
    database_url: String,
    listen_addr: SocketAddr,
    base_domain: String,
    admin_path: String,
    admin_password_hash: String,
    admin_session_secret: Vec<u8>,
    trusted_ips: Vec<IpAddr>,
}

impl Config {
    fn from_env() -> anyhow::Result<Self> {
        let admin_path = env_required("ADMIN_PATH")?;
        if !admin_path.starts_with('/') {
            anyhow::bail!("ADMIN_PATH must start with '/' (e.g. /your-secret-path)");
        }

        let secret_hex = env_required("ADMIN_SESSION_SECRET")?;
        let admin_session_secret = hex::decode(&secret_hex)
            .map_err(|e| anyhow::anyhow!("ADMIN_SESSION_SECRET must be hex: {e}"))?;
        if admin_session_secret.len() < 32 {
            anyhow::bail!("ADMIN_SESSION_SECRET must decode to >= 32 bytes");
        }

        let trusted_ips = std::env::var("TRUSTED_IPS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| {
                let s = s.trim();
                if s.is_empty() {
                    None
                } else {
                    s.parse::<IpAddr>().ok()
                }
            })
            .collect();

        Ok(Self {
            database_url: env_required("DATABASE_URL")?,
            listen_addr: env_required("LISTEN_ADDR")?
                .parse()
                .map_err(|e| anyhow::anyhow!("LISTEN_ADDR: {e}"))?,
            base_domain: env_required("BASE_DOMAIN")?,
            admin_path,
            admin_password_hash: env_required("ADMIN_PASSWORD_HASH")?,
            admin_session_secret,
            trusted_ips,
        })
    }
}

fn env_required(name: &str) -> anyhow::Result<String> {
    std::env::var(name).map_err(|_| anyhow::anyhow!("required env var {name} is not set"))
}
