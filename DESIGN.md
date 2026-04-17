# anarchy.lgbt registry — rust port design doc

*version 1.0 — chrys + claude, 2026-04-16*

---

## 1. context

anarchy.lgbt is a public custom-handle provider for the bluesky / atproto ecosystem. users claim a subdomain of the form `{chosen}.anarchy.lgbt`, bind it to their bluesky DID, and then configure bluesky to use it as their handle. the service resolves `.well-known/atproto-did` on each subdomain so that the atproto network can verify the mapping.

the service is deliberately minimal in its user-facing relationship. there are no accounts, no email addresses, no passwords, no recovery flows. when a user claims a handle, they receive a **secret key** (a 24-character token) which is the *only* thing that authenticates future management. lose the secret, lose access. this is a feature, not a limitation.

the service is run as a small-scale public utility by a single operator. it provides a caretaker admin surface for maintaining the health of the shared space: blocking abusive DIDs, blocking specific PDS hosts that become sources of abuse, reserving handles, banning keywords (slurs), and responding to operational incidents. this admin surface is *not* user-monitoring infrastructure — it is the janitorial toolkit for a public utility, used by the person responsible for keeping the space livable.

### the existing system

the first version of anarchy.lgbt was built in october 2025 using cloudflare workers with KV storage. it was the operator's second natural-language programming project (the first being goodgirls.onl). at the time the operator was working without vscode, without git, without cli familiarity, with an LLM that had no cross-session context. the worker grew organically to include a full PDS proxy, a signup flow at `join.anarchy.lgbt`, did:web serving infrastructure, and multi-domain support — many of which were "what else can i do with this" exploration rather than core requirements.

### this port

this port is **the registry core only**, extracted from the larger system. pds proxying, signup flow, did:web serving, and multi-domain support are explicitly out of scope and will not be carried forward in this rewrite.

this port is also a deliberate **growth artifact**. the original was shipped under constraints that produced specific weaknesses. the rust version preserves the operator's intent while demonstrating improvements in security, architecture, observability, and correctness. the "improvements and why" section (section 4) is the centerpiece of the portfolio narrative.

this port is a **production replacement** for the existing worker. when complete, it will serve real users, handling a full cutover from cloudflare workers to the rust service on the operator's portfolio VPS.

---

## 2. goals and non-goals

### goals

**functional parity with the existing worker for the scoped surface.** the ported features must behave identically from the user's and operator's perspectives. a user who successfully claims `foo.anarchy.lgbt` via the existing worker must be able to do the same via the rust service, receive a secret key in the same format, and manage the handle the same way. an operator logging into the admin surface must see the same data, exercise the same policies, and get the same outcomes. no capability is lost in translation.

**measurable improvements over the original along specific axes.** the port is not a translation — it is a rewrite informed by what the operator has learned since october. specifically:

- the admin password will be hashed with argon2id (user tokens remain SHA-256 — see section 4.1 for reasoning)
- all hash comparisons will be constant-time
- the public and admin surfaces will follow a non-enumeration policy: unknown / unauthorized / over-limit requests return uniform 404s rather than distinguishable status codes
- administrative state-changing endpoints will require CSRF protection (defense-in-depth)
- the admin login will be rate-limited against brute-force
- multi-record writes will occur inside sqlite transactions so partial writes cannot corrupt state
- every page's theme rendering will share a single templating path; no drift between pages

**a production replacement.** the rust service will ship as a single static binary, deploy to the operator's ovh portfolio box via systemd, sit behind caddy as a reverse proxy, use sqlite as its store, and be fronted by cloudflare for tls termination and ddos absorption. upon successful verification, DNS will be cut over from cloudflare workers to the rust service, making it the live production system.

**portfolio legibility.** the code, the design doc, the adversarial review notes, and the commit history together should tell a coherent story about how a system grew from a first javascript attempt into a disciplined rust service. a reviewer should be able to follow the reasoning without needing the operator to narrate it.

### non-goals

**the PDS proxy layer.** the existing worker proxies requests to the anarchy.lgbt personal data server, intercepting `updateHandle` and `deleteAccount` to keep the registry in sync. this logic is substantial, tightly coupled to a specific PDS deployment, and orthogonal to the registry itself. it stays on the worker for now.

**the signup flow at `join.anarchy.lgbt`.** creating new bluesky accounts on the anarchy.lgbt PDS is a separate concern. the rust registry will not create accounts. users bring their own DIDs (from any PDS) and bind handles to them.

**did:web serving.** the existing worker can serve arbitrary `did:web` documents via a KV-backed override mechanism. this is a useful capability but is not part of the registry core. stays on the worker.

**multi-domain support.** the existing worker can serve handles under multiple configured domains via `SUPPORTED_DOMAINS`. the rust port will hardcode `anarchy.lgbt` (via a single env var) and treat multi-domain as a future extension, not a v1 feature.

**passwordless or oauth-based auth.** the secret-key model is the model. no email-based recovery, no oauth, no account linking. the existing auth philosophy stays.

**high availability or horizontal scaling.** this is a single-instance service running on a single vps with a single sqlite file. if the box is down, the service is down. the ovh automated backups and operator-managed sqlite exports are the durability story. no clustering, no replication, no load balancer.

---

## 3. data model

### tables

**`handles`** — one row per registered subdomain

| column | type | notes |
|---|---|---|
| `sub` | TEXT | primary key; the subdomain portion, e.g. `foo` for `foo.anarchy.lgbt`; always lowercase |
| `did` | TEXT | foreign key → `dids.did`; indexed for reverse lookup |
| `created_at` | TEXT | ISO 8601 UTC timestamp |

**`dids`** — one row per DID that owns at least one handle

| column | type | notes |
|---|---|---|
| `did` | TEXT | primary key |
| `secret_hash` | TEXT | SHA-256 hash of the user's secret key; never null |
| `created_at` | TEXT | ISO 8601 UTC |

**`config_vip_dids`**, **`config_blocked_dids`**, **`config_blocked_pds`**, **`config_blocked_keywords`**, **`config_reserved_handles`** — five lookup tables, each with schema:

| column | type | notes |
|---|---|---|
| `value` | TEXT | primary key; lowercase |
| `added_at` | TEXT | ISO 8601 UTC |
| `note` | TEXT | optional operator note; nullable |

split into five tables rather than a unified `config_lists(kind, value)` table because: (a) query patterns differ per list, (b) growth rates differ, (c) schema can evolve independently (e.g. adding `expires_at` to blocked keywords doesn't touch VIPs).

**`activity_log`** — ring buffer, capped at 1000 rows

| column | type | notes |
|---|---|---|
| `id` | INTEGER | primary key autoinc |
| `ts` | TEXT | ISO 8601 UTC |
| `event_type` | TEXT | `register` / `delete` / `register_blocked_did` / `register_blocked_pds` / `register_blocked_keyword` / `admin_assign_reserved` / `admin_delete_all` |
| `did` | TEXT | nullable |
| `sub` | TEXT | nullable |
| `pds_host` | TEXT | nullable |

oldest rows pruned on insert when count exceeds 1000. (increased from worker's 200 — KV write costs were the original constraint; sqlite has no such constraint.)

**`rate_limit_buckets`** — time-bucketed rate limit counters

| column | type | notes |
|---|---|---|
| `key` | TEXT | e.g. `ip:1.2.3.4:register:hour:2026040620` |
| `count` | INTEGER | |
| `expires_at` | INTEGER | unix epoch; background sweep deletes expired |

### indexes

- `handles.did` — reverse lookup (find all handles for a DID)
- `activity_log.ts` — for time-range queries in metrics
- `rate_limit_buckets.expires_at` — for background cleanup

### what we are explicitly *not* modeling

- **users.** there's no users table. DIDs are pseudonymous identities; we don't associate any PII with them.
- **sessions.** admin session lives in a signed cookie, not a database row. one less table, session expiry handled by cookie max-age.
- **audit trail beyond activity_log.** the 1000-row ring buffer is operator-facing diagnostics, not compliance-grade audit.

### data types and formats

- **timestamps**: ISO 8601 UTC strings everywhere. sqlite doesn't have a real datetime type; we standardize on ISO 8601 for consistency with existing KV data and readability in exports.
- **case**: subdomains, DIDs, pds hosts, and keywords are all lowercased on insert. validation before insert rejects anything that doesn't fit the normalized form.

### schema evolution

migrations live in `migrations/` as numbered .sql files. `sqlx` runs pending migrations at service startup.

### startup behavior

- if the database file doesn't exist, create it and run all migrations (clean start)
- if it exists, run any pending migrations (upgrade)
- if the schema is ahead of the binary's migrations (rollback scenario), log an error and refuse to start
- if the file is corrupted (sqlite integrity check fails), log an error and refuse to start; operator restores from backup

---

## 4. what i'm improving and why

### 4.1 secret hashing: SHA-256 unchanged for user tokens; argon2id for admin password

**user tokens — unchanged:** the worker hashes user secrets with SHA-256. user secrets are 24-char random tokens from a 31-char alphabet — ~119 bits of entropy. brute force against 119 bits is computationally infeasible regardless of hash speed. argon2id's cost-per-guess protection is designed for low-entropy passwords (30-50 bits), not high-entropy random tokens. using argon2id here would add ~50-100ms per auth operation with zero security benefit, and at scale (hundreds of concurrent logins), would introduce meaningful CPU load for no gain. SHA-256 is the correct choice for this threat model.

**admin password — upgraded to argon2id:** the admin password is human-chosen and has realistic entropy (probably 40-80 bits depending on the operator's habits). this is exactly the threat model argon2id is built for. the worker stored the admin password hash as SHA-256 (`REGISTER_TOKEN_HASH`); the rust version uses argon2id with tuned cost parameters.

**why different algorithms for different contexts:** applying the expensive algorithm only where the threat model warrants it is a stronger engineering signal than applying it everywhere. it demonstrates evaluation of actual risk rather than pattern-matching on "best practices."

### 4.2 hash comparison: short-circuit → constant-time

**before:** `if (keyHash !== stored)` in javascript. string equality short-circuits on the first differing byte, creating a timing side-channel.

**after:** all hash comparisons use constant-time equality (the `subtle` crate or equivalent). response time is identical regardless of how close a guess is.

**why:** timing attacks against hash comparisons are a textbook vulnerability. practically exploitable over a network? debatable. worth preventing? absolutely — it's one function call and closes the class entirely.

### 4.3 information disclosure: mixed status codes → uniform 404s

**before:** the worker returns distinguishable responses for different failure modes. `401` for missing auth, `403` for wrong auth, `404` for missing records, `409` for conflicts, `429` for rate limits. the admin login page renders on `GET /gg` even for unauthenticated visitors.

**after:** non-enumeration as a first principle.

- unauthenticated requests to admin routes return 404
- wrong admin passwords return 404
- rate-limited requests return 404 (not 429)
- blocked DID / blocked PDS / blocked keyword rejections on registration return the same "this handle is not available" message as a legitimately taken handle
- `.well-known/atproto-did` returns 404 for all failure modes identically
- no `Server` header, no version strings in error responses, no `X-Powered-By`

**design tension acknowledged:** non-enumeration conflicts with helpful user feedback on registration. the compromise: all "you can't have this handle" conditions (taken, reserved, blocked keyword) return the same generic "this handle is not available" message. this leaks one bit (the handle is unavailable for *some* reason) but doesn't distinguish between reasons.

**why:** this philosophy was developed during the operator's work on a larger project (hideaway) and is being applied retroactively here as a demonstration of growth. every distinguishable response is information an attacker can use to build a model of the system.

### 4.4 admin authentication: cookie-only → cookie + CSRF + rate limiting

**before:** the admin console authenticates via an `anarchy_admin=1` HttpOnly cookie. no CSRF token, no login rate limiting.

**after:**

- admin login is at an obscure, configurable path (env var `ADMIN_PATH`)
- the login page is a static file on the portfolio box, served by caddy — the rust service never serves it
- wrong passwords produce no distinguishable response (404, per section 4.3)
- login attempts are rate-limited per IP (5 attempts per 10 minutes, then silent 404s)
- successful login sets a signed session cookie (HMAC-signed token with expiry, not just `=1`)
- all admin POST endpoints require a CSRF token (defense-in-depth; SameSite=Lax already provides primary CSRF protection, but belt-and-suspenders is cheap)
- all admin responses include `Cache-Control: no-store, private` to prevent CDN caching of authenticated content

**why:** defense-in-depth. the worker's admin auth was the minimum viable thing. on a portfolio box with a public IP, the attack surface is larger. the CSRF risk is low given the secret admin path + SameSite cookies, but the mitigation is cheap and the defense-in-depth posture is itself a portfolio signal.

### 4.5 data integrity: key-value store → transactional sqlite

**before:** cloudflare KV is eventually consistent and non-transactional. a handle registration writes two records as separate operations. partial failure produces inconsistent state.

**after:** sqlite with WAL mode. multi-record writes are wrapped in transactions. either both succeed or neither does.

**why:** KV was the right choice for cloudflare workers. sqlite is the right choice for a vps service. the move isn't a critique of KV — it's choosing the right tool for the new deployment model.

### 4.6 architecture: single file → layered crate

**before:** one javascript file containing routing, business logic, data access, html rendering, css, and client-side javascript. functions defined inside other functions. some functions defined twice with different implementations (outer shadowed by inner).

**after:** layered rust crate:

- `routes.rs` — axum router definition
- `handlers/public.rs` and `handlers/admin.rs` — request/response handling
- `service.rs` — business logic, no http or sql awareness
- `db.rs` — sqlite queries
- `validate.rs` — input validation and normalization
- `auth.rs` — hashing, session signing, CSRF generation/validation
- `rate_limit.rs` — bucket management
- `theme.rs` — pride theme data and decoration types
- `atproto.rs` — external API calls (handle resolution, PLC directory)
- `error.rs` — error types

each layer depends only on the layer below it. testable in isolation.

**why:** the monolithic file was the only option available under the original constraints. the layered structure is what you do when you have the tools and understanding to do it properly. the contrast is itself the growth story.

### 4.7 theme rendering: duplicated logic → single source

**before:** server picks a theme and renders it into html via string interpolation, AND client fetches `/themes` to re-pick on load. four page renderers each implement theme application slightly differently.

**after:** one `Theme` struct with a `Decoration` enum. one rendering path via askama templates. server picks a default on render; client handles rerolls via the dice. no duplicated logic.

**why:** duplicated rendering logic drifts. a single source of truth means adding a new theme or page can't introduce inconsistency.

### 4.8 observability: console.log → structured tracing

**before:** `console.log` and `console.error` — unstructured strings.

**after:** the `tracing` crate with structured fields. every request gets a request ID. log lines include endpoint, outcome, and relevant context as key-value pairs.

**why:** structured logging is the difference between "something broke" and "i know exactly what broke, when, and for whom."

---

## 5. api surface

### conventions

- all request bodies are JSON (`Content-Type: application/json`)
- all success responses are JSON
- all failure responses from public endpoints return `{"error": "..."}` with a human-readable message
- **non-enumeration rule:** any request to an unrecognized path, or any unauthorized request to a protected path, returns a plain `404 Not Found` with body `not found`. no json, no headers that distinguish it from a genuinely missing page.
- rate-limited requests return `404 Not Found` (not 429)
- the admin surface is invisible to unauthenticated visitors
- no `Server`, `X-Powered-By`, or version headers on any response
- all admin responses include `Cache-Control: no-store, private`

### public endpoints

**`POST /register`** — register a new handle

request:
```json
{"handle": "alice.bsky.social", "subdomain": "alice"}
```

success (first claim for this DID):
```json
{"ok": true, "did": "did:plc:abc123", "handle": "alice.anarchy.lgbt", "secret_key": "abc...xyz"}
```

success (DID already has a secret, adding another handle):
```json
{"ok": true, "did": "did:plc:abc123", "handle": "alice.anarchy.lgbt"}
```

failure cases (all return the same shape):
- handle invalid format → `{"error": "Handle must be 4-40 characters, lowercase letters, digits, or hyphens."}`
- handle not available (taken, reserved, OR blocked keyword — same message) → `{"error": "This handle is not available."}`
- bsky handle can't be resolved → `{"error": "Could not resolve your Bluesky handle."}`
- DID is blocked → `{"error": "This handle is not available."}`
- PDS is blocked → `{"error": "This handle is not available."}`
- handle limit reached → `{"error": "Handle limit reached. Contact the operator for assistance."}`
- rate limited → **404** (not json, not 429)

**`POST /manage`** — list or delete handles using secret key

list request:
```json
{"action": "list", "secret": "abc...xyz"}
```

list success:
```json
{"ok": true, "did": "did:plc:abc123", "handles": [{"sub": "alice", "created_at": "2026-01-15T..."}]}
```

delete request:
```json
{"action": "delete", "secret": "abc...xyz", "sub": "alice"}
```

delete success:
```json
{"ok": true, "did": "did:plc:abc123", "deleted": "alice.anarchy.lgbt"}
```

failure cases:
- missing or wrong secret → `{"error": "Invalid secret key."}`
- sub not owned by this secret → `{"error": "This secret does not control that handle."}`
- rate limited → **404**

**`GET /.well-known/atproto-did`** (served per-subdomain)

success: plain text body containing the DID. `Content-Type: text/plain; charset=utf-8`. `Cache-Control: public, max-age=300`.

failure (any reason): plain `not found`, status 404.

**`GET /`** — main page (themed html, claim form)

**`GET /m`** — manage page (themed html, secret key form)

**`GET /a`** — about page (themed html)

**`GET /themes`** — json array of all pride themes for client-side dice reroll

```json
[
  {
    "name": "Trans Pride",
    "background": "linear-gradient(135deg, ...)",
    "bright": false,
    "decoration": {
      "type": "sigil",
      "character": "⚧",
      "placement": "bottom-right",
      "color": "#ffffff",
      "size_px": 48,
      "weight": 400,
      "opacity": 0.35
    }
  }
]
```

### admin endpoints

**every admin endpoint** returns 404 if the session cookie is missing or invalid.

**`GET {ADMIN_PATH}`** — returns 404 if not authenticated. returns admin console html if authenticated.

**`POST {ADMIN_PATH}`** — login. correct password → set session cookie, return admin console. wrong password → 404.

**`GET {ADMIN_PATH}/logout`** — clears session cookie, returns 404.

**`GET {ADMIN_PATH}/dids`** — returns all DIDs and their handles as json.

**`POST {ADMIN_PATH}/delete-handle`** — remove one handle. `{"did": "...", "sub": "..."}`

**`POST {ADMIN_PATH}/delete-did`** — remove all handles for a DID. `{"did": "..."}`

**`GET {ADMIN_PATH}/config`** — returns current policy (vip, blocked dids, blocked pds, blocked keywords, reserved handles).

**`POST {ADMIN_PATH}/config`** — modify policy (`addVipDid`, `removeVipDid`, `addBlockDid`, etc).

**`GET {ADMIN_PATH}/activity`** — returns activity log (up to 1000 events, newest first).

**`GET {ADMIN_PATH}/metrics`** — returns registrations/hour, top PDS hosts, IP spikes.

**`POST {ADMIN_PATH}/resolve`** — resolve a bluesky handle to a DID. `{"handle": "someone.bsky.social"}`

**`POST {ADMIN_PATH}/assign-handle`** — assign a reserved handle to a DID (generates new secret if DID is new). `{"did": "...", "sub": "..."}`

**`POST {ADMIN_PATH}/preview-keyword`** — returns list of currently-registered handles that would be blocked by a given substring. `{"keyword": "..."}` Used by admin UI to show blast radius before committing a keyword block.

**`GET {ADMIN_PATH}/export-config`** — download config as json.

**`POST {ADMIN_PATH}/import-config`** — upload config json (replaces current).

**`GET {ADMIN_PATH}/export-registry`** — download registry as json or csv (`?format=json` or `?format=csv`).

**`POST {ADMIN_PATH}/import-registry`** — upload registry json (destructive replace).

**all admin POST endpoints require a valid CSRF token.**

---

## 6. theme system

### overview

every public page (`/`, `/m`, `/a`) and the admin login page render with a randomly-selected pride/identity theme. the theme determines the page's background and an optional decoration element. users can reroll the theme by clicking a dice element in the top-left corner of the page's shell.

### theme data structure

```rust
struct Theme {
    name: String,
    background: String,       // css value
    decoration: Decoration,
    bright: bool,             // triggers fog mode (dark glass shell)
}

enum Decoration {
    Sigil {
        character: String,
        placement: Placement,
        color: String,
        size_px: u32,
        weight: u32,
        opacity: f32,
    },
    CornerBadge {
        // intersex ring — SVG, random corner per render
        random_corner: bool,
    },
    None,
}

enum Placement {
    BottomRight,
    TopLeft,
    TopRight,
    BottomLeft,
}
```

### complete theme inventory

1. Rainbow Pride
2. Trans Pride
3. Lesbian Pride
4. Gay Pride
5. Nonbinary Pride
6. Intersex
7. BPD Awareness
8. Dissociation Awareness
9. Transfemme
10. Transmasc
11. Genderfluid
12. Asexual
13. Aromantic
14. Aroace
15. Autism
16. Plural
17. DID
18. OSDD
19. Depersonalization
20. Derealization
21. Polyamory

**standard sigil themes** (default: bottom-right, #ffffff, 48px, weight 400, opacity 0.35):
Rainbow Pride (✺), Trans Pride (⚧), Nonbinary Pride (✧), BPD Awareness (♾︎), Dissociation Awareness (⧖), Transfemme (⚧), Transmasc (⚧), Genderfluid (⚨), Asexual (✕), Aromantic (❀), Aroace (❁), Plural (⚯), OSDD (⟁), Depersonalization (◌), Derealization (⌬), Polyamory (∞❤)

**custom sigil themes:**

| name | sigil | placement | color | size | weight | opacity |
|---|---|---|---|---|---|---|
| Lesbian Pride | ⚢ | bottom-right | #fb7185 | 36px | 800 | 0.9 |
| Gay Pride | ⚣ | top-left | #3b82f6 | 30px | 700 | 0.9 |
| Autism | ∞ | top-right | #ffdd00 | 38px | 800 | 0.9 |

**special rendering:**

| name | decoration type | notes |
|---|---|---|
| Intersex | CornerBadge | yellow bg with purple SVG ring; random corner per render |
| DID | None | dark gradient, no decoration |

### fog mode

themes with bright backgrounds where the shell sits get a dark-tinted glass treatment instead of default light-tinted glass, ensuring text readability.

```css
/* default shell */
.shell {
  background: rgba(255,255,255,0.14);
  border: 1px solid rgba(255,255,255,0.22);
}

/* fog mode */
body.fog .shell {
  background: rgba(0,0,0,0.18);
  border-color: rgba(255,255,255,0.26);
}

body.fog .shell input {
  background: rgba(255,255,255,0.16);
  border-color: rgba(255,255,255,0.24);
}
```

themes that need fog mode: Nonbinary Pride, Intersex, Aromantic, Aroace, Autism (final list tuned during implementation by visual inspection).

### dice reroll

- position: absolute, top-left of shell header, `left: 6px`, vertically centered
- visual: no button chrome — no border, no background, no padding. naked glyph.
- color: `rgba(255,255,255,0.92)`
- size: 16px
- cursor: `default !important` — no pointer on hover
- opacity: 0.75 at rest, 0.85 on hover (only hover signal is subtle opacity bump)
- no box-shadow on any state
- focus-visible: subtle 1px white outline for keyboard accessibility only
- `aria-label="shuffle theme"` for screen readers
- behavior: picks new random theme excluding current (every click produces visible change)
- toggles fog mode when crossing bright/non-bright boundary
- does not persist across page loads or between pages

### server's role in theming

- server picks one random theme at render time via askama template
- `GET /themes` returns the full theme list as json for client-side dice reroll
- server and client use the same theme data

---

## 7. verification criteria

### registration flow

- [ ] user can claim a handle by providing bsky handle + desired subdomain
- [ ] first claim for a DID returns a 24-char secret key
- [ ] subsequent claims for the same DID do not return a new secret
- [ ] subdomain validation rejects: under 4 chars, over 40 chars, non-lowercase-alphanumeric-hyphen, leading/trailing hyphens, double hyphens, unicode invisibles, punycode
- [ ] reserved handles return "this handle is not available"
- [ ] blocked keyword handles return "this handle is not available"
- [ ] blocked DID registrations return "this handle is not available"
- [ ] blocked PDS registrations return "this handle is not available"
- [ ] handle limit per DID is enforced (5 for normal, unlimited for VIP)
- [ ] registration writes handle + DID records in a single transaction
- [ ] secret is hashed with SHA-256 before storage

### handle management

- [ ] user can list their handles by providing their secret
- [ ] user can delete a specific handle by providing their secret + subdomain
- [ ] deleting the last handle for a DID removes the DID record entirely
- [ ] wrong secret returns "invalid secret key" (does not distinguish wrong vs nonexistent)
- [ ] secret verification uses constant-time comparison

### handle resolution

- [ ] `GET {sub}.anarchy.lgbt/.well-known/atproto-did` returns the correct DID as plain text
- [ ] missing/invalid/corrupt subdomain returns identical 404
- [ ] response includes `Cache-Control: public, max-age=300`

### admin surface

- [ ] unauthenticated GET to admin path returns 404
- [ ] unauthenticated POST with wrong password returns 404
- [ ] unauthenticated POST with correct password sets signed session cookie and returns admin console
- [ ] admin login is rate-limited (5 attempts per 10 minutes per IP, then 404)
- [ ] all admin POST endpoints require valid CSRF token
- [ ] admin can list all DIDs and their handles
- [ ] admin can delete a single handle
- [ ] admin can delete all handles for a DID
- [ ] admin can add/remove VIP DIDs
- [ ] admin can add/remove blocked DIDs
- [ ] admin can add/remove blocked PDS hosts
- [ ] admin can add/remove blocked keywords (comma-separated bulk add)
- [ ] admin can preview keyword blast radius before committing
- [ ] admin can add/remove reserved handles
- [ ] admin can assign a reserved handle to a DID (generates new secret if DID is new)
- [ ] admin can resolve a bsky handle to a DID
- [ ] admin can view activity log (up to 1000 events, newest first)
- [ ] admin can view traffic metrics (registrations/hour, top PDS, IP spikes)
- [ ] admin can export config as json
- [ ] admin can import config from json
- [ ] admin can export registry as json or csv
- [ ] admin can import registry from json (destructive replace)
- [ ] admin logout clears session cookie and returns 404

### non-enumeration

- [ ] unrecognized paths return plain `not found` 404
- [ ] admin paths return 404 when unauthenticated
- [ ] rate-limited requests return 404
- [ ] blocked registrations return same message as taken handles
- [ ] wrong admin password returns 404
- [ ] no `Server`, `X-Powered-By`, or version headers on any response
- [ ] `.well-known/atproto-did` failures are indistinguishable from missing paths

### rate limiting

- [ ] global per-IP: 100 ops/hour
- [ ] burst per-IP on register: 10 attempts/minute
- [ ] per-DID on register: 10/hour normal, 60/hour VIP
- [ ] per-PDS on register: 100/hour
- [ ] admin + trusted IPs bypass all rate limits
- [ ] expired rate limit buckets are cleaned up periodically
- [ ] over-limit returns 404, not 429

### themes

- [ ] all 21 themes present with correct backgrounds
- [ ] standard sigils: bottom-right, white, 48px, weight 400, opacity 0.35
- [ ] lesbian sigil: bottom-right, #fb7185, 36px, weight 800, opacity 0.9
- [ ] gay sigil: top-left, #3b82f6, 30px, weight 700, opacity 0.9
- [ ] autism sigil: top-right, #ffdd00, 38px, weight 800, opacity 0.9
- [ ] intersex: SVG ring badge in random corner, no text sigil
- [ ] DID theme: no decoration
- [ ] bright themes render with fog mode (dark glass shell)
- [ ] fog mode toggles correctly on dice reroll
- [ ] dice in top-left of shell header, 16px, opacity 0.75 → 0.85 on hover
- [ ] dice cursor stays default arrow
- [ ] dice click rerolls theme (excludes current from pool)
- [ ] page loads with server-selected theme (no flash of unstyled content)
- [ ] `GET /themes` returns full theme list as json
- [ ] text is legible on all 21 themes with their respective glass treatment

### security

- [ ] user secrets hashed with SHA-256
- [ ] admin password hashed with argon2id
- [ ] all hash comparisons are constant-time
- [ ] session cookies are HMAC-signed with expiry
- [ ] CSRF tokens generated per session, validated on all admin POSTs
- [ ] admin login form is a static file, not served by the rust service
- [ ] `.env` file contains all secrets, not committed to git
- [ ] `.env.example` in repo with placeholder values

### deployment

- [ ] single static binary runs on portfolio box
- [ ] systemd service with restart-on-failure
- [ ] caddy reverse proxy with automatic https
- [ ] cloudflare in front for ddos + tls termination
- [ ] sqlite database at a known path with operator-managed backups
- [ ] admin responses include `Cache-Control: no-store, private`

### data integrity

- [ ] all multi-record writes are transactional
- [ ] activity log is capped at 1000 rows
- [ ] rate limit buckets expire and are cleaned up
- [ ] subdomains, DIDs, keywords are lowercased on insert
- [ ] service refuses to start if database schema is ahead of binary's migrations
- [ ] service refuses to start if database is corrupted

---

## 8. deployment plan

### infrastructure

- **box:** ovh vps-1, 4 vcpu / 8gb / 75gb nvme, LA datacenter, ubuntu 24.04
- **hostname:** portfolio
- **user:** ubuntu (sudo)
- **ssh:** key-only, root disabled
- **firewall:** ufw, allow 22/80/443 only
- **auto-updates:** unattended-upgrades with 4am ET reboot

### build strategy

compile locally in WSL2 (ubuntu on windows), targeting `x86_64-unknown-linux-gnu`. scp binary to portfolio box. fallback: github actions CI if WSL proves problematic.

### filesystem layout

```
/opt/anarchy-registry/
├── anarchy-registry          # binary
├── .env                      # config (not in git)
├── data/
│   └── registry.db           # sqlite
├── backups/                  # operator-managed sqlite copies
└── static/
    └── enter.html            # admin login page (served by caddy)
```

### systemd service

```ini
[Unit]
Description=anarchy.lgbt handle registry
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/anarchy-registry
EnvironmentFile=/opt/anarchy-registry/.env
ExecStart=/opt/anarchy-registry/anarchy-registry
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### caddy

```
*.anarchy.lgbt, anarchy.lgbt {
    reverse_proxy 127.0.0.1:3000
    header -Server
    header -X-Powered-By
}
```

plus: static admin login page at the operator's chosen obscure path. cloudflare trusted proxy headers for real client IP logging.

### cloudflare

- dns for `anarchy.lgbt` pointed at portfolio box IP, proxied (orange cloud)
- wildcard `*.anarchy.lgbt` CNAME → `anarchy.lgbt`, proxied
- ssl mode: full (strict) with cloudflare origin cert on caddy
- caching: standard; `/themes` cacheable; `.well-known/atproto-did` cached 5 minutes

### backups

- ovh automated backup (included free, runs nightly)
- cron job: copy `registry.db` to `/opt/anarchy-registry/backups/` with date suffix, keep last 7 days
- admin export endpoints available for on-demand config + registry download

### environment variables

```
DATABASE_URL=sqlite:///opt/anarchy-registry/data/registry.db
ADMIN_PATH=/your-secret-path-here
ADMIN_PASSWORD_HASH=argon2id-hash-here
ADMIN_SESSION_SECRET=random-64-char-hex-here
BASE_DOMAIN=anarchy.lgbt
LISTEN_ADDR=127.0.0.1:3000
TRUSTED_IPS=1.2.3.4,5.6.7.8
```

`.env.example` in repo with placeholder values; `.env` in `.gitignore`.

---

## 9. cutover plan

### pre-cutover

1. rust service built, deployed to portfolio box, passing all verification criteria against test/seed data
2. caddy configured and serving the rust service
3. local machine `/etc/hosts` entries added pointing `anarchy.lgbt` and test subdomains at portfolio box IP for pre-cutover verification
4. `.well-known/atproto-did` verified to resolve correctly for both real users' handles via hosts-file routing
5. hosts-file entries removed after verification

### cutover sequence

1. export current worker KV state (2 real DID records + config) via worker's admin export endpoints
2. import config into rust service via admin import endpoint
3. pre-assign both real users' handles via admin `assign-handle` flow (new argon2id-hashed admin, SHA-256-hashed user secrets)
4. send friend her new secret key via secure channel
5. update cloudflare dns: point `anarchy.lgbt` and `*.anarchy.lgbt` at portfolio box IP
6. purge cloudflare cache for `*.anarchy.lgbt` immediately after dns flip
7. verify both handles resolve via the live domain
8. verify bluesky recognizes both handles (may take a few minutes for bsky's resolver cache)
9. monitor activity log for unexpected traffic patterns

### rollback

- worker remains deployed but inactive for 1 week post-cutover
- if something breaks: revert cloudflare dns to point at worker (~5 min propagation)
- worker's KV still has old data; existing secrets still work there
- coordinate with friend if rollback happens

### decommission

- after 1 week clean: disable the worker
- after 1 month: delete the worker and KV namespace

---

## 10. out-of-scope followups

documented here so a reviewer can see the operator understands what's not in v1 and has thought about the path forward.

**PDS proxy layer.** a separate service sitting between cloudflare and the PDS, intercepting handle changes and account deletions to sync with the registry. could talk to registry's sqlite directly or via internal API.

**signup flow.** `join.anarchy.lgbt` with invite-based account creation. separate service, separate concern.

**did:web serving.** KV-backed `/.well-known/did.json` mechanism. useful, orthogonal, future project.

**multi-domain support.** extending `BASE_DOMAIN` to a comma-separated list. adds complexity to validation, theming, and admin UI. future version.

**the clock service.** a tiny rust web service at `time.chrysanthemum.dev` returning current time as json. first project after anarchy ships. deployment dry-run and a time endpoint for claude.

**goodgirls.onl port.** the simpler handle provider. architecturally a subset of anarchy. can share crate-level code if structured as a workspace.

---

## file structure

```
anarchy-registry/
├── Cargo.toml
├── DESIGN.md                 # this document
├── .env.example
├── .gitignore
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_config_tables.sql
├── src/
│   ├── main.rs               # config, db pool, server startup
│   ├── routes.rs              # axum router definition
│   ├── handlers/
│   │   ├── mod.rs
│   │   ├── public.rs          # register, manage, delete, well-known
│   │   └── admin.rs           # all {ADMIN_PATH}/* endpoints
│   ├── service.rs             # business logic
│   ├── db.rs                  # sqlite queries
│   ├── atproto.rs             # handle resolution, PLC directory
│   ├── validate.rs            # subdomain rules, normalization
│   ├── auth.rs                # SHA-256, argon2id, session signing, CSRF
│   ├── rate_limit.rs          # bucket management
│   ├── theme.rs               # pride theme data and decoration types
│   └── error.rs               # error types
├── templates/                 # askama templates
│   ├── index.html             # main page (themed)
│   ├── manage.html            # manage page (themed)
│   └── about.html             # about page (themed)
├── static/
│   └── admin.html             # admin console SPA (include_str!, served by rust)
└── tests/
    └── integration.rs
```

---

*this document was adversarially reviewed twice. attacks addressed: overengineered secondary index (kept as deliberate portfolio choice), argon2id scope (narrowed to admin-only after threat model evaluation), HMAC key management risk (eliminated by returning to SHA-256 for user tokens), OVERRIDE_DOMAIN production risk (eliminated — use /etc/hosts for testing), keyword substring false positives (added preview-before-add), static-vs-server-rendered html conflict (resolved: rust serves themed pages via askama), activity log capacity (increased to 1000), build strategy (WSL2 local compile), admin console templating (include_str! SPA), startup failure modes (specified), CDN cache interactions (cache-control headers + cutover cache purge).*
