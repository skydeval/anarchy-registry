# anarchy.lgbt registry

A custom Bluesky handle provider for the queer internet. Users claim a subdomain like `yourname.anarchy.lgbt`, bind it to their Bluesky DID, and manage it with a secret key. No accounts, no email, no recovery — just a key and a handle.

**Live at [anarchy.lgbt](https://anarchy.lgbt)**

![anarchy.lgbt screenshot](anarchy-preview.png)

## The story

The first version of anarchy.lgbt was built in October 2025 as a Cloudflare Worker — my second project ever, written with ChatGPT, without VS Code, without git, without CLI experience. I was copy-pasting entire files across context windows to keep the project alive. It worked. It ran in production for six months with real users and zero downtime.

This is the Rust port. Not a translation — a rewrite informed by everything I learned in those six months about security, architecture, and building things that last. The Worker stayed running until the Rust service was deployed, tested, and verified. Then I cut DNS over and the Rust version took its place.

This project is part of the [Navigators Guild apprentice program](https://github.com/Navigators-Guild/apprentice-onboarding), which teaches agentic AI development through real projects with design docs, adversarial review, and portfolio artifacts. The methodology used here is Verification Driven Development via Iterative Adversarial Refinement (VDD/IAR): define what success looks like before you build, build with AI agents, stress-test the results, and improve through honest critique.

## What improved in the port

Every change from the Worker to the Rust version was deliberate. The design doc (included in this repo as `DESIGN.md`) explains the reasoning for each.

**Security**

- **Secret hashing**: SHA-256 → argon2id. The Worker hashed user secrets with a single unsalted SHA-256 pass. The Rust version uses argon2id with per-secret random salt and tuned cost parameters. The admin password also uses argon2id. Different algorithms for different threat models — user tokens have 119 bits of entropy (SHA-256 would be fine), but the admin password is human-chosen (argon2id is necessary). Using the right tool for each context is the point.
- **Hash comparison**: Short-circuit string equality → constant-time comparison. Every hash comparison in the Rust version uses constant-time operations to close timing side-channel attacks.
- **Non-enumeration**: The Worker returned distinguishable status codes for different failure modes (401 for missing auth, 403 for wrong auth, 429 for rate limits). The Rust version returns identical 404s for all unauthorized, unrecognized, and rate-limited requests. Blocked registrations return the same "not available" message as legitimately taken handles. The admin path returns 404 for wrong passwords. An attacker scanning the service learns nothing about what's behind any endpoint.
- **CSRF protection**: All admin POST endpoints require a per-session CSRF token. The Worker had none.
- **Admin login rate limiting**: 5 attempts per 10 minutes per IP, then silent 404s. The Worker had no login rate limiting.

**Architecture**

- **Single file → layered crate**: The Worker was one 3000+ line JavaScript file with functions defined inside other functions, some defined twice with different implementations. The Rust version is organized into layers: routes, handlers, service logic, database queries, validation, auth, rate limiting, themes — each in its own module, each testable in isolation.
- **Eventual consistency → transactions**: The Worker wrote subdomain and DID records as separate KV puts. If one succeeded and the other failed, the data was inconsistent. The Rust version wraps multi-record writes in SQLite transactions.
- **Full table scan → indexed lookup**: The Worker scanned every DID record to find a matching secret hash on login. The Rust version uses a SHA-256 prefix index for O(log n) candidate lookup, then argon2id verification on candidates.
- **Duplicated theme rendering → single source**: The Worker had four separate page renderers with slightly different theme application logic. The Rust version has one shared template base.

**Observability**

- `console.log` → structured `tracing` with request IDs, endpoint context, and machine-parseable key-value fields.

## Features

- **Handle registration**: Claim `yourname.anarchy.lgbt` by providing your Bluesky handle. Receive a secret key on first claim.
- **Handle management**: List and delete your handles using your secret key. No accounts, no passwords, no email.
- **Handle resolution**: `yourname.anarchy.lgbt/.well-known/atproto-did` returns your DID for Bluesky verification.
- **21 pride themes**: Rainbow, Trans, Lesbian, Gay/MLM, Nonbinary, Intersex, BPD Awareness, Dissociation Awareness, Transfeminine, Transmasculine, Genderfluid, Asexual, Aromantic, Aroace, Autism, Plural Pride, DID Awareness, OSDD Awareness, Depersonalization Awareness, Derealization Awareness, Polyamory. Each with canonical flag colors, random gradient directions, and themed sigil decorations.
- **Dice reroll + theme picker**: Click the dice for a random theme, or use the dropdown to pick a specific one. Each selection randomizes the gradient direction.
- **Admin console**: Full caretaker dashboard behind a hidden, rate-limited, CSRF-protected admin path. VIP list, DID/PDS/keyword blocklists, reserved handles, handle assignment, activity log, traffic metrics, registry export/import, keyword preview tool.
- **Keyword preview**: Test a potential blocked keyword against a common English word list to see false positives before committing. A feature the Worker never had.

## Tech stack

- **Rust** with Axum (web framework), SQLx (async SQLite), Askama (templates)
- **SQLite** with WAL mode for storage
- **Caddy** as reverse proxy with Cloudflare origin TLS certificates
- **Cloudflare** for DNS, DDoS protection, and TLS termination (orange cloud / Full Strict)
- **systemd** for process management on an OVH VPS (Ubuntu 24.04)

## Running locally

```bash
cp .env.example .env
# Edit .env — see comments in .env.example for each variable

# Generate an admin password hash:
cargo run -- --hash-password 'your-password-here'
# Paste the output into ADMIN_PASSWORD_HASH in .env
# Wrap it in single quotes if it contains $ characters

# Generate a session secret:
openssl rand -hex 32
# Paste into ADMIN_SESSION_SECRET in .env

# Create the data directory:
mkdir -p data

# Run:
cargo run
# Visit http://localhost:3000
```

## Tests

```bash
cargo test
```

119 tests (99 unit + 20 integration). Integration tests drive the real Axum router via `tower::ServiceExt::oneshot` and cover registration flow, handle resolution, admin auth, CSRF gating, non-enumeration, and cache headers.

## Deployment

The service compiles to a single static binary (~11MB) and deploys via `scp` + `systemctl restart`. No Docker, no container runtime, no package manager on the production box.

```bash
cargo build --release
scp target/release/anarchy-registry user@server:/opt/anarchy-registry/
ssh server sudo systemctl restart anarchy-registry
```

Caddy reverse-proxies from port 443 to the service on localhost:3000. Cloudflare handles public TLS termination; Caddy uses a Cloudflare origin certificate for the Cloudflare→origin leg.

## Design doc

The full design document is included as [`DESIGN.md`](DESIGN.md). It covers context, goals/non-goals, data model, security improvements, API surface, theme system, verification criteria, deployment plan, cutover plan, and out-of-scope followups. It was written before any code and adversarially reviewed twice (17 attacks total).

## License

This project is not currently licensed for reuse. It's a personal portfolio piece and a live production service.
