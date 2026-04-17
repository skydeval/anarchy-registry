// anarchy.lgbt handle registry worker

const VERSION = "1.0";
const BASE_DOMAIN = "anarchy.lgbt";

const SUB_PREFIX = "sub:";      // sub:<subdomain>  -> { did, createdAt }
const DID_PREFIX = "did:";      // did:<did>        -> { keyHash, createdAt, handles[] }

const VIP_KEY = "config:vip";
const BLOCK_KEY = "config:block";
const ACTIVITY_KEY = "activity:recent";

const MAX_HANDLES_PER_DID = 5;       // per DID (non-VIP)
const MAX_ACTIVITY_EVENTS = 200;     // admin activity log ring buffer

const REGISTRY_BASE_DOMAIN = "anarchy.lgbt"; // the only domain /gg should care about

// Shared shadow stack for all sigils (no glow)
const SIGIL_SHADOW = `
  0px 4px 3px rgba(0,0,0,0.35),
  0px 8px 6px rgba(0,0,0,0.30),
  0px 14px 12px rgba(0,0,0,0.24),
  0px 22px 20px rgba(0,0,0,0.20)
`.trim();
function parseSupportedDomains(env) {
  const raw = env.SUPPORTED_DOMAINS || "";
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(d => d.replace(/^\./, "")); // strip leading dots if someone adds them
}

function isValidLocalPart(local) {
  if (!local) return false;
  if (local.length < 4 || local.length > 40) return false;
  if (!/^[a-z0-9-]+$/.test(local)) return false;
  return true;
}
function isValidSubdomain(sub) {
  if (typeof sub !== "string") return false;
  const s = sub.trim();
  if (s.length < 4 || s.length > 40) return false;
  return /^[a-z0-9-]+$/.test(s);
}

function resolveDomain(env, requestedDomain) {
  const domains = parseSupportedDomains(env);
  const match = domains.find(
    d => d.toLowerCase() === requestedDomain.toLowerCase()
  );
  return match || null;
}
async function deleteRegistryForDid(env, did) {
  const didStr = String(did);
  const didKey = DID_PREFIX + didStr;
  const existingDidRaw = await env.anarchydids.get(didKey);
  if (!existingDidRaw) {
    return;
  }

  let didRecord;
  try {
    didRecord = JSON.parse(existingDidRaw) || {};
  } catch {
    didRecord = {};
  }

  const handles = Array.isArray(didRecord.handles) ? didRecord.handles : [];
  const subs = handles
    .map(h => (typeof h === "string" ? h : h && h.sub))
    .filter(Boolean);

  // Delete sub:<sub> entries that belong to this DID
  for (const sub of subs) {
    const subKey = SUB_PREFIX + sub;
    const subRaw = await env.anarchydids.get(subKey);
    if (!subRaw) continue;

    try {
      const subRec = JSON.parse(subRaw) || {};
      if (subRec.did === didStr) {
        await env.anarchydids.delete(subKey);
      }
    } catch {
      // Corrupt? Just delete it.
      await env.anarchydids.delete(subKey);
    }
  }

  // Finally delete did:<did> entry
  await env.anarchydids.delete(didKey);
}

async function handleSignupRequest(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  const { localPart, domain, email, password, inviteCode } = payload || {};

  // Basic field checks
  if (!localPart || !domain || !email || !password || !inviteCode) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // Handle rules: 4–40, [a-z0-9-]
  if (!isValidLocalPart(localPart)) {
    return new Response(
      JSON.stringify({
        error:
          "Handle must be 4–40 characters of lowercase letters, digits, or hyphens."
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // Domain must be in SUPPORTED_DOMAINS
  const resolvedDomain = resolveDomain(env, domain);
  if (!resolvedDomain) {
    return new Response(
      JSON.stringify({
        error: "That domain is not allowed on this server."
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  const handle = `${localPart}.${resolvedDomain}`; // e.g. chrys.anarchy.lgbt

  const pdsOrigin = env.PDS_ORIGIN || "https://pds.anarchy.lgbt";
  const url = `${pdsOrigin}/xrpc/com.atproto.server.createAccount`;

  const pdsBody = {
    email,
    handle,
    password,
    inviteCode
    // you can add did or recoveryKey later if you want
  };

  let pdsResp;
  try {
    pdsResp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(pdsBody)
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error:
          "Could not reach the PDS. Try again in a little while or contact the admin."
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  const text = await pdsResp.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!pdsResp.ok) {
    let message = "Signup failed.";
    if (json.message) message = json.message;
    if (json.error) message = json.error;

    return new Response(
      JSON.stringify({ error: message, details: json }),
      {
        status: pdsResp.status,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // Mirror into registry via internal bridge
// Mirror into registry ONLY for *.anarchy.lgbt
if (pdsResp.ok && json && json.did && resolvedDomain === BASE_DOMAIN) {
  try {
    const subdomain = localPart.toLowerCase().trim();
    const bridgeUrl = new URL("/internal/pds/claim", request.url);

    await fetch(bridgeUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${env.PDS_BRIDGE_TOKEN || ""}`
      },
      body: JSON.stringify({
        subdomain,
        did: json.did
      })
    });
  } catch (err) {
    console.error("PDS→registry bridge failed (api/signup)", err);
  }
}

  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
async function handlePdsAccountDeleted(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || token !== env.PDS_BRIDGE_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const did = typeof body.did === "string" ? body.did.trim() : "";
  if (!did) {
    return jsonResponse({ error: "Missing did" }, { status: 400 });
  }

  const didKey = DID_PREFIX + did;
  const existingDidRaw = await env.anarchydids.get(didKey);
  if (!existingDidRaw) {
    // Nothing to do, but not an error
    return jsonResponse({ ok: true, did, removed: false });
  }

  let didRecord;
  try {
    didRecord = JSON.parse(existingDidRaw) || {};
  } catch {
    didRecord = {};
  }

  const handles = Array.isArray(didRecord.handles) ? didRecord.handles : [];
  const subs = handles
    .map(h => (typeof h === "string" ? h : h && h.sub))
    .filter(Boolean);

  // Delete sub:<sub> entries that point at this DID
  for (const sub of subs) {
    const subKey = SUB_PREFIX + sub;
    const subRaw = await env.anarchydids.get(subKey);
    if (!subRaw) continue;

    try {
      const subRec = JSON.parse(subRaw) || {};
      if (subRec.did === did) {
        await env.anarchydids.delete(subKey);
      }
    } catch {
      // If corrupt, just delete it
      await env.anarchydids.delete(subKey);
    }
  }

  // Finally delete did:<did> record itself
  await env.anarchydids.delete(didKey);

  return jsonResponse({
    ok: true,
    did,
    removed: true,
    removedSubs: subs
  });
}
async function handlePdsChangeHandle(env, request) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || token !== env.PDS_BRIDGE_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const did = typeof body.did === "string" ? body.did.trim() : "";
  const oldSub = typeof body.oldSub === "string" ? body.oldSub.trim().toLowerCase() : "";
  const newSub = typeof body.newSub === "string" ? body.newSub.trim().toLowerCase() : "";

  if (!did || !oldSub || !newSub) {
    return jsonResponse({ error: "Missing did, oldSub, or newSub" }, { status: 400 });
  }

  if (!isValidSubdomain(newSub)) {
    return jsonResponse(
      { error: "New handle must be 4–40 chars of [a-z0-9-]." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  // 1) Check newSub is not already claimed by a different DID
  const newSubKey = SUB_PREFIX + newSub;
  const newSubRaw = await env.anarchydids.get(newSubKey);
  if (newSubRaw) {
    try {
      const rec = JSON.parse(newSubRaw) || {};
      if (rec.did && rec.did !== did) {
        return jsonResponse(
          { error: "That handle is already claimed by another DID." },
          { status: 409 }
        );
      }
    } catch {
      // corrupt; we'll overwrite below
    }
  }

  // 2) Update did:<did> record
  const didKey = DID_PREFIX + did;
  const existingDidRaw = await env.anarchydids.get(didKey);
  if (!existingDidRaw) {
    return jsonResponse(
      { error: "No registry record exists for this DID." },
      { status: 404 }
    );
  }

  let didRecord;
  try {
    didRecord = JSON.parse(existingDidRaw) || {};
  } catch {
    didRecord = {};
  }

  const baseCreated = didRecord.createdAt || now;
  const rawHandles = Array.isArray(didRecord.handles) ? didRecord.handles : [];
  let changed = false;

  const normalizedHandles = rawHandles
    .map(h => {
      if (typeof h === "string") {
        // legacy string → object
        if (h === oldSub) {
          changed = true;
          return { sub: newSub, createdAt: baseCreated };
        }
        return { sub: h, createdAt: baseCreated };
      }

      if (h && typeof h.sub === "string") {
        if (h.sub === oldSub) {
          changed = true;
          return {
            sub: newSub,
            createdAt: h.createdAt || baseCreated
          };
        }
        return {
          sub: h.sub,
          createdAt: h.createdAt || baseCreated
        };
      }

      return null;
    })
    .filter(Boolean);

  if (!changed) {
    // oldSub not found; we can choose to treat this as error or just append
    normalizedHandles.push({ sub: newSub, createdAt: now });
  }

  didRecord.createdAt = baseCreated;
  didRecord.handles = normalizedHandles;

  await env.anarchydids.put(didKey, JSON.stringify(didRecord));

  // 3) Update sub:<oldSub> and sub:<newSub>

  const oldSubKey = SUB_PREFIX + oldSub;
  const oldSubRaw = await env.anarchydids.get(oldSubKey);
  if (oldSubRaw) {
    try {
      const oldRec = JSON.parse(oldSubRaw) || {};
      if (oldRec.did === did) {
        await env.anarchydids.delete(oldSubKey);
      }
    } catch {
      await env.anarchydids.delete(oldSubKey);
    }
  }

  const newSubRecord = {
    did,
    createdAt: now
  };
  await env.anarchydids.put(newSubKey, JSON.stringify(newSubRecord));

  return jsonResponse({
    ok: true,
    did,
    oldSub,
    newSub
  });
}


// --------------------------
// Pride flag themes for main page
// --------------------------
const PRIDE_THEMES = [
  {
    name: "Rainbow Pride",
    sigil: "✺",
    background:
      "linear-gradient(135deg,#ff0000 0%,#ff7f00 16%,#ffff00 32%,#00ff00 48%,#0000ff 64%,#4b0082 80%,#8b00ff 100%)"
  },
  {
    name: "Trans Pride",
    background:"linear-gradient(135deg,#5bcffa 0%,#5bcffa 10%,#f5a9b8 32%,#ffffff 50%,#f5a9b8 68%,#5bcffa 90%,#5bcffa 100%)"
    ,sigil: "⚧"
  },
  {
    name: "Lesbian Pride",
    background:
      "linear-gradient(135deg,#d52d00 0%,#ef7627 16%,#ff9a56 32%,#ffffff 48%,#d162a4 64%,#b55690 80%,#a30262 100%)",
    sigil: "⚢",
    sigilSide: "before",
    sigilCss: `
      color: #fb7185 !important;
      font-size: 36px !important;
      font-weight: 800 !important;
      bottom: 2rem !important;
      right: 2rem !important;
      top: auto !important;
      left: auto !important;
    `
  },
  {
    name: "Gay Pride",
    background:
      "linear-gradient(135deg,#0f4c81 0%,#61c5f0 20%,#ffffff 40%,#f7a8b8 60%,#ec4f7f 80%)",
    sigil: "⚣",
    sigilSide: "before", // uses ::before, same as the old implementation
    sigilCss: `
      color: #3b82f6 !important;
      font-size: 30px !important;
      font-weight: 700 !important;
  
      /* top-left corner placement */
      top: 2rem !important;
      left: 2rem !important;
      right: auto !important;
      bottom: auto !important;
    `
  },
  {
    name: "Nonbinary Pride",
    sigil: "✧",
    background:
      "linear-gradient(135deg,#fff433 0%,#ffffff 25%,#9b59d0 50%,#2c2c2c 75%)"
  },
      // plain yellow; ring will be added dynamically
  {
    name: "intersex",
    background: "#f7e11e"
  },
  {
    name: "BPD Awareness",
    sigil: "♾︎",
    background:
      "linear-gradient(135deg,#ff75a2 0%,#ffffff 33%,#7de0c5 66%,#000000 100%)"
  },
  {
    // soft, floaty colors – not an official standard, just a vibe
    name: "Dissociation Awareness",
    sigil: "⧖",
    background:
      "linear-gradient(135deg,#0f172a 0%,#1e293b 20%,#94a3b8 40%,#f9fafb 55%,#a855f7 75%,#0f172a 100%)"
  },
  {
    // transfemme: leaning pink/purple with trans colors
    name: "transfemme",
    sigil: "⚧",
    background:
      "linear-gradient(135deg,#f5a9b8 0%,#f9d0e5 16%,#ffffff 32%,#c4a5ff 48%,#a855f7 64%,#5bcffa 80%)"
  },
  {
    // transmasc: leaning blue/teal with trans white
    name: "transmasc",
    sigil: "⚧",
    background:
      "linear-gradient(135deg,#5bcffa 0%,#4f9bd9 16%,#ffffff 32%,#4ade80 48%,#15803d 64%,#0f172a 80%)"
  },
  {
    name: "genderfluid",
    sigil: "⚨",
    background:
      "linear-gradient(135deg,#ff75a2 0%,#ffffff 20%,#be4bdb 40%,#000000 60%,#2b6bff 80%)"
  },
  {
    name: "asexual",
    sigil: "✕",
    background:
      "linear-gradient(135deg,#000000 0%,#4b5563 25%,#ffffff 50%,#7c3aed 75%)"
  },
  {
    name: "aromantic",
    sigil: "❀",
    background:
      "linear-gradient(135deg,#3aa63f 0%,#a7d379 25%,#ffffff 50%,#a9a9a9 75%,#000000 100%)"
  },
  {
    name: "aroace",
    sigil:"❁",
    background:
      "linear-gradient(135deg,#3da542 0%,#86d7c7 20%,#ffffff 40%,#a3a3a3 60%,#000000 80%)"
  },
  {
    // autism pride – there are multiple variants; this is a rainbow + gold lean
    name: "autism",
    background:
      "linear-gradient(135deg,#ff9f1c 0%,#ff595e 20%,#ffca3a 40%,#8ac926 60%,#1982c4 80%,#6a4c93 100%)",
    sigil: "∞",
    sigilSide: "after",
    sigilCss: `
      color: #ffdd00 !important;
      font-size: 38px !important;
      font-weight: 800 !important;
      top: 2rem !important;
      right: 2rem !important;
      bottom: auto !important;
      left: auto !important;
    `  
  },
  {
     //plural pride — purple → white → green horizontal vibe
    name: "plural",
    background:
      "linear-gradient(135deg,#3f1a6b 0%,#6e3fa8 18%,#ffffff 50%,#4fa86b 82%,#1f5a32 100%)",
    sigil: "⚯"
  },
  {
    // DID-inspired: dim, deep, layered, a bit liminal
    name: "did",
    background:
      "linear-gradient(135deg,#020617 0%,#111827 25%,#312e81 50%,#6d28d9 75%,#f472b6 100%)"
  },
  {
    // OSDD-ish: softer, foggier gradient, still purple/blue anchored
    name: "osdd",
    background:
      "linear-gradient(135deg,#020617 0%,#1f2937 20%,#4b5563 40%,#6366f1 65%,#a855f7 100%)",
    sigil: "⟁"
  },
  {
    // depersonalization: washed-out, bodyless, ghosty pastel spectrum
    name: "depersonalization",
    sigil: "◌",
    background:
      "linear-gradient(135deg,#0f172a 0%,#1f2937 18%,#e5e7eb 45%,#c4b5fd 70%,#f9a8d4 100%)"
  },
  {
    // derealization: surreal neon edges over a dark, cool base
    name: "derealization",
    sigil: "⌬",
    background:
      "linear-gradient(135deg,#020617 0%,#111827 30%,#22c55e 55%,#38bdf8 75%,#f97316 100%)"
  },
  {
    name: "polyamory",
    background: `
      linear-gradient(
        135deg,
        #0057B7 0%,
        #0057B7 24%,
        #D62828 40%,
        #D62828 72%,
        #000000 100%
      )
    `,
    sigil: "∞❤"
  }
  
];


function pickPrideTheme() {
  if (!PRIDE_THEMES.length) {
    return {
      name: "fallback",
      background: "linear-gradient(135deg,#111827,#020617)"
    };
  }
  const idx = Math.floor(Math.random() * PRIDE_THEMES.length);
  return PRIDE_THEMES[idx] || PRIDE_THEMES[0];
}
        
// ---------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------
function getSubdomainFromHost(host, baseDomain) {
  // host: "foo.anarchy.lgbt", baseDomain: "anarchy.lgbt" -> "foo"
  if (!host || !baseDomain) return null;
  host = host.toLowerCase();
  baseDomain = baseDomain.toLowerCase();

  if (host === baseDomain) return ""; // root
  if (!host.endsWith("." + baseDomain)) return null;

  return host.slice(0, host.length - (baseDomain.length + 1)); // remove ".baseDomain"
}

// Soft rate-limit key prefixes
const RATE_DID_PREFIX = "rate:did:";
const RATE_IP_PREFIX  = "rate:ip:";
const RATE_PDS_PREFIX = "rate:pds:";
// Global + burst rate limiting
const GLOBAL_IP_WINDOW_SECONDS = 3600;   // 1 hour
const GLOBAL_IP_MAX_OPS        = 100;    // 100 ops per IP per hour
const BURST_IP_WINDOW_SECONDS = 60;   // 1 minute
const BURST_IP_MAX_OPS = 10;         // register attempts/minute/IP


// Try to get a stable-ish client IP from CF / proxy headers
function getClientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf;

  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }

  return null;
}
function isTrustedIp(env, request) {
  const ip = getClientIp(request);
  if (!ip) return false;

  const raw = env.TRUSTED_IPS || "";
  const list = raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return list.includes(ip);
}

// Increment a moving time-window bucket. Returns true if over the limit.
async function incrementGuard(env, keyPrefix, windowSeconds, maxCount) {
  const now = Date.now();
  const bucket = Math.floor(now / (windowSeconds * 1000));
  const key = `${keyPrefix}${bucket}`;

  let count = 0;
  const raw = await env.anarchydids.get(key);
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed)) {
      count = parsed;
    }
  }

  count += 1;

  // Keep each bucket around a bit longer than its window
  await env.anarchydids.put(key, String(count), {
    expirationTtl: windowSeconds * 2
  });

  return count > maxCount;
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(v.join("="));
  });
  return out;
}
const SECURITY_HEADERS = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Content-Security-Policy": [
    "default-src 'self';",
    "script-src 'self' 'unsafe-inline';",
    "style-src 'self' 'unsafe-inline';",
    "img-src 'self' data:;",
    "connect-src 'self' https://bsky.social https://plc.directory;",
    "frame-ancestors 'none';"
  ].join(" ")
};

function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

function htmlResponse(html, init = {}) {
  return new Response(html, {
    status: init.status || 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
      ...(init.headers || {})
    }
  });
}

async function parseJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function normalizeHandle(raw) {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (s.startsWith("@")) s = s.slice(1);
  return s || null;
}

function normalizeSubdomain(raw) {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  return s;
}

function generateSecretKey(length = 24) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}

async function hashString(value) {
  const enc = new TextEncoder();
  const data = enc.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------
// DID resolution (Bluesky identity)
// ---------------------------------------------------------

async function resolveDidFromHandle(handle) {
  if (!handle) return null;
  if (handle.startsWith("did:")) return handle;

  handle = handle.replace(/^@/, "").toLowerCase();

  try {
    const res = await fetch(
      "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=" +
        encodeURIComponent(handle),
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------
// DID → PDS host resolution (via PLC DID document)
// ---------------------------------------------------------

async function resolvePdsHostForDid(did) {
  // Right now everything Bluesky gives you is did:plc:..., but future-proof a bit.
  if (!did || typeof did !== "string") return null;
  if (!did.startsWith("did:plc:")) return null;

  try {
    const res = await fetch(
      "https://plc.directory/" + encodeURIComponent(did),
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) {
      return null;
    }

    const doc = await res.json();
    const services = Array.isArray(doc.service) ? doc.service : [];

    // Look for the Atproto PDS-ish service entry.
    for (const svc of services) {
      if (!svc || typeof svc !== "object") continue;

      const type = String(svc.type || "").toLowerCase();
      const endpoint = svc.serviceEndpoint || svc.endpoint;
      if (!endpoint) continue;

      // Typical PLC doc: type "AtprotoPersonalDataServer" or similar.
      if (type.includes("atproto") && type.includes("pds")) {
        try {
          const url = new URL(endpoint);
          return url.hostname.toLowerCase();
        } catch {
          // bad URL? ignore and keep scanning
        }
      }
    }

    // Fallback: if nothing matched but there *is* some serviceEndpoint, try first one
    if (services.length > 0) {
      const first = services[0];
      const endpoint = first && (first.serviceEndpoint || first.endpoint);
      if (endpoint) {
        try {
          const url = new URL(endpoint);
          return url.hostname.toLowerCase();
        } catch {
          return null;
        }
      }
    }

    return null;
  } catch {
    // Network / JSON error – don’t break registration, just no host info.
    return null;
  }
}

// ---------------------------------------------------------
// VIP / Block config + Activity log
// ---------------------------------------------------------

async function loadVipConfig(env) {
  const raw = await env.anarchydids.get(VIP_KEY);
  if (!raw) return { vipDids: {} };
  try {
    const parsed = JSON.parse(raw);
    return { vipDids: parsed.vipDids || {} };
  } catch {
    return { vipDids: {} };
  }
}

async function saveVipConfig(env, cfg) {
  await env.anarchydids.put(
    VIP_KEY,
    JSON.stringify({ vipDids: cfg.vipDids || {} })
  );
}

async function loadBlockConfig(env) {
  const raw = await env.anarchydids.get(BLOCK_KEY);
  if (!raw) {
    return { blockDids: {}, blockPds: {}, blockedKeywords: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      blockDids: parsed.blockDids || {},
      blockPds: parsed.blockPds || {},
      blockedKeywords: parsed.blockedKeywords || {}
    };
  } catch {
    return { blockDids: {}, blockPds: {}, blockedKeywords: {} };
  }
}

async function saveBlockConfig(env, cfg) {
  await env.anarchydids.put(
    BLOCK_KEY,
    JSON.stringify({
      blockDids: cfg.blockDids || {},
      blockPds: cfg.blockPds || {},
      blockedKeywords: cfg.blockedKeywords || {}
    })
  );
}


async function logActivity(env, event) {
  const raw = await env.anarchydids.get(ACTIVITY_KEY);
  let data;
  if (!raw) {
    data = { events: [] };
  } else {
    try {
      data = JSON.parse(raw);
      if (!Array.isArray(data.events)) data.events = [];
    } catch {
      data = { events: [] };
    }
  }

  data.events.push(event);
  if (data.events.length > MAX_ACTIVITY_EVENTS) {
    data.events = data.events.slice(-MAX_ACTIVITY_EVENTS);
  }

  await env.anarchydids.put(ACTIVITY_KEY, JSON.stringify(data));
}

async function loadRecentActivity(env) {
  const raw = await env.anarchydids.get(ACTIVITY_KEY);
  if (!raw) return { events: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.events)) return { events: [] };
    return { events: parsed.events };
  } catch {
    return { events: [] };
  }
}

// Helper: find DID + record by secret key hash
async function findDidBySecretHash(env, secretHash) {
  let cursor = undefined;
  while (true) {
    const { keys, cursor: next } = await env.anarchydids.list({
      prefix: DID_PREFIX,
      cursor
    });

    for (const k of keys) {
      const didKey = k.name;
      const did = didKey.slice(DID_PREFIX.length);
      const rec = await env.anarchydids.get(didKey, "json");
      if (!rec) continue;
      if (rec.keyHash === secretHash) {
        return { did, record: rec };
      }
    }

    if (!next) break;
    cursor = next;
  }
  return null;
}
async function loadReservedConfig(env) {
  const raw = await env.anarchydids.get("config:reserved");
  if (!raw) return { reservedHandles: {} };
  try {
    const parsed = JSON.parse(raw);
    return {
      reservedHandles: parsed.reservedHandles || {}
    };
  } catch {
    return { reservedHandles: {} };
  }
}

async function saveReservedConfig(env, cfg) {
  await env.anarchydids.put(
    "config:reserved",
    JSON.stringify({
      reservedHandles: cfg.reservedHandles || {}
    })
  );
}

// ---------------------------------------------------------
// Build Sigils
// ---------------------------------------------------------
function buildSigilAttrs(theme) {
  if (!theme) return "";

  let out = "";

  if (theme.sigil) {
    out += ` data-sigil-char="${theme.sigil}"`;
  }

  if (theme.sigilSide) {
    // "before" or "after"
    out += ` data-sigil-side="${theme.sigilSide}"`;
  }

  return out;
}

function buildSigilOverrideStyle(theme) {
  if (!theme || !theme.sigilCss) return "";

  const side = theme.sigilSide === "after" ? "after" : "before";
  const css = theme.sigilCss.replace(/\s+/g, " ").trim();

  // Ensure intersex never overrides sigil behavior
  if ((theme.name || "").toLowerCase().includes("intersex")) {
    return "";
  }

  return `
<style id="sigil-overrides">
  body[data-sigil-char]::${side} {
    opacity: 0.9 !important;
    ${css};
  }
</style>`;
}

function buildIntersexRingCss() {
  // SVG ring
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="#f7e11e"/>
    <circle cx="50" cy="50" r="24" fill="none" stroke="#7b2fbf" stroke-width="10" />
  </svg>`;

  const encoded = encodeURIComponent(svg);

  // random corner
  const placements = [
    { top: "1.8rem", left: "2.4rem" },
    { top: "1.8rem", right: "2.4rem" },
    { bottom: "2.4rem", left: "2.4rem" },
    { bottom: "2.4rem", right: "2.4rem" }
  ];
  const pos = Object.entries(
    placements[Math.floor(Math.random() * placements.length)]
  ).map(([k, v]) => `  ${k}: ${v};`).join("\n");

  // IMPORTANT: use body::after, not ::before
  // This prevents collision with theme sigils & the default system.
  return `
body::after {
  content: "";
  position: fixed;
  width: 160px;
  height: 160px;
  background-image: url("data:image/svg+xml,${encoded}");
  background-repeat: no-repeat;
  background-size: contain;
  opacity: 0.98;
  pointer-events: none;
  z-index: 0;
${pos}
}
`.trim();
}

// ---------------------------------------------------------
// Public UI HTML
// ---------------------------------------------------------

function renderRootPage({ baseDomain, version, theme }) {
  const intersexExtraCss =
    theme && theme.name === "intersex" ? buildIntersexRingCss() : "";
  
    const background =
    theme && typeof theme.background === "string" && theme.background.trim()
      ? theme.background
      : "#020617"; // fallback dark bg so it never goes white

      const sigilChar =
      theme && typeof theme.sigil === "string" && theme.sigil.length
        ? theme.sigil
        : "";

    const sigilSide =
      theme && theme.sigilSide === "after" ? "after" : "before";

    const bodySigilAttrs = sigilChar
      ? ` data-sigil-char="${sigilChar}" data-sigil-side="${sigilSide}"`
      : "";
      

  return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Anarchy.LGBT Handles</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta property="og:title" content="${baseDomain}" />
    <meta property="og:description" content="Claim a unique anarchy.lgbt handle for your bluesky account" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://${baseDomain}/" />
    <style>
      input:-webkit-autofill,
      input:-webkit-autofill:hover,
      input:-webkit-autofill:focus {
        -webkit-text-fill-color: var(--fg-main) !important;
        transition: background-color 9999s ease-in-out 0s;
        box-shadow: 0 0 0px 1000px var(--input-bg) inset !important;
      }
      :root {
        --bg-base: #110014;
        --fg-main: #fdf4ff;
        --fg-muted: #c7b3d7;

        --accent-pink: #ff4b9a;
        --accent-pink-soft: rgba(255, 75, 154, 0.35);
        --accent-blue: #53c4ff;
        --accent-blue-soft: rgba(83, 196, 255, 0.35);
        --accent-rainbow-border: rgba(255, 180, 225, 0.6);

        --input-bg: rgba(8, 0, 20, 0.9);
        --input-border: rgba(120, 92, 160, 0.8);
        --input-border-focus: #53c4ff;
        --input-shadow-focus: 0 0 0 1px rgba(83, 196, 255, 0.6);

        --button-primary-bg: linear-gradient(135deg, #ff4b9a, #ff8fd6);
        --button-primary-bg-hover: linear-gradient(135deg, #ff6fb0, #ffc1e6);
        --button-danger-bg: linear-gradient(135deg, #ff3e5f, #ff7b8e);

        --shell-bg: rgba(5, 0, 14, 0.82);
        --shell-border: rgba(255, 134, 187, 0.55);
        --shell-shadow: 0 18px 45px rgba(0, 0, 0, 0.8);
      }

      html, body {
        height: 100%;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          sans-serif;

        display: flex;
        justify-content: center;
        align-items: center;

        background:${background};

        background-attachment: fixed;
        background-repeat: no-repeat;
        background-size: cover;
        color: var(--fg-main);
      }
      body[data-sigil-char]::before,
      body[data-sigil-char]::after {
        opacity: var(--sigil-opacity, 0.35);
      }
      
      @media (max-height: 680px) {
        body {
          align-items: flex-start;
          padding-top: 2rem;
        }
      }
      .handle-instructions {
        margin-top: 0.6rem;
        font-size: 0.82rem;
        line-height: 1.5;
        color: var(--fg-muted);
      }
      
      .secret-key-box {
        margin-top: 0.75rem;
        padding: 0.7rem 0.85rem;
        border-radius: 14px;
        background: rgba(7, 0, 20, 0.9);
        border: 1px solid rgba(148, 163, 184, 0.7);
      }
      
      .secret-key-label {
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(203, 213, 225, 0.9);
        margin-bottom: 0.35rem;
      }
      
      .secret-key-value code {
        display: inline-block;
        font-size: 0.89rem;
        padding: 0.18rem 0.7rem;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.96);
        border: 1px solid rgba(148, 163, 184, 0.85);
      }
      
      .secret-key-note {
        margin-top: 0.55rem;
        font-size: 0.82rem;
        line-height: 1.5;
        color: var(--fg-muted);
      }
      .master-key-highlight {
        font-size: 0.86rem;
        font-weight: 600;
        display: inline-block;
        margin-bottom: 0.15rem;
        text-alignment: justify;
      }
                  
      .secret-key-domain {
        font-weight: 600;
        color: var(--accent-blue);
      }
                  
      .shell {
        max-width: 420px;
        width: 100%;
        margin: 0;
        padding: 1.75rem 2rem;
        border-radius: 18px;
        background: var(--shell-bg);
        backdrop-filter: blur(4px);
        box-shadow: var(--shell-shadow);
        border: 1px solid var(--shell-border);
        overflow: hidden;
        position: relative;
        z-index: 1;      
      }

      h1 {
        font-size: 2rem;
        margin: 0 0 0.4rem;
      }

      h1 span {
        font-weight: 700;
      }

      p {
        margin: 0.35rem 0;
        line-height: 1.6;
        color: var(--fg-main);
      }

      .hint {
        font-size: 0.8rem;
        color: var(--fg-muted);
      }

      form {
        margin-top: 1.75rem;
        display: grid;
        gap: 1rem;
      }

      label {
        display: block;
        font-size: 0.9rem;
        margin-bottom: 0.25rem;
        opacity: 0.9;
        color: var(--fg-main);
      }

      input[type="text"],
      input[type="password"] {
        width: 100%;
        max-width: 100%;
        padding: 0.6rem 7.5rem 0.6rem 0.75rem;
        border-radius: 10px;
        border: 1px solid var(--input-border);
        background: var(--input-bg);
        color: var(--fg-main);
        font-size: 0.95rem;
        outline: none;
        box-sizing: border-box;
        transition:
          border-color 0.15s ease-out,
          box-shadow 0.15s ease-out,
          background-color 0.15s ease-out;
      }

      input::placeholder {
        color: rgba(199, 179, 215, 0.7);
      }

      input:focus {
        border-color: var(--input-border-focus);
        box-shadow: var(--input-shadow-focus);
        background: rgba(8, 0, 24, 0.95);
      }

      button {
        border-radius: 999px;
        padding: 0.6rem 1.4rem;
        border: none;
        font-weight: 600;
        font-size: 0.95rem;
        cursor: pointer;
        letter-spacing: 0.01em;
        transition:
          transform 0.08s ease-out,
          box-shadow 0.08s ease-out,
          filter 0.08s ease-out,
          background 0.15s ease-out;
      }

      button:disabled {
        opacity: 0.6;
        cursor: default;
        box-shadow: none;
        transform: none;
      }

      .primary {
        background: #334155;      
        border-color: #475569;
        color: #f1f5f9;
            }

      .primary:hover:not(:disabled) {
        background: #60a5fa;
        border-color: #93c5fd;
        color: #0b1120;
            }

      .primary.btn-claim:hover:not(:disabled) {
        background: #60a5fa !important;
        color: #0b1120 !important;
        border-color: #93c5fd !important;
            }

      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        font-size: 0.8rem;
        background: rgba(255, 255, 255, 0.08);
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      .footer {
        margin-top: 1.5rem;
        font-size: 0.8rem;
        opacity: 0.9;
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        align-items: center;
        color: var(--fg-muted);
      }
      
      .version-badge {
        padding: 0.2rem 0.7rem;
        border-radius: 999px;
        border: 1px solid var(--accent-rainbow-border);
        font-size: 0.75rem;
        color: var(--fg-muted);
        background: rgba(7, 0, 20, 0.9);
      }

      a.footer-link {
        color: var(--accent-blue);
        text-decoration: none;
        font-weight: 500;
        margin-left: auto;
      }

      a.footer-link:hover {
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      @media (max-width: 520px) {
        .footer {
          flex-wrap: nowrap;
        }
      
        .footer-link {
          white-space: nowrap;
          font-size: 0.78rem;
        }
      
        .version-badge {
          font-size: 0.72rem;
          padding: 0.18rem 0.6rem;
        }
      }

      .inline-steps {
        margin-top: 0.5rem;
        font-size: 0.8rem;
        opacity: 0.9;
        color: var(--fg-muted);
      }

      .inline-steps span {
        white-space: nowrap;
      }

      .handle-wrapper {
        position: relative;
        width: 100%;
        max-width: 100%;
      }

      .handle-wrapper input {
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        display: block;
      }

      .handle-suffix {
        position: absolute;
        right: 0.9rem;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
        font-size: 0.95rem;
        font-weight: 600;

        background: linear-gradient(
          90deg,
          #ff6b6b,
          #ffb347,
          #ffe76b,
          #51d88a,
          #4dabff,
          #b784ff
        );
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;

        text-shadow: 0 0 4px rgba(0, 0, 0, 0.7);
       

      }
      ${intersexExtraCss}
   @media (max-width: 640px) {
   
     body {
       display: flex;
       justify-content: center;
       align-items: center;
       min-height: 100dvh;
       padding: 1rem;
       box-sizing: border-box;
     }
   
     .shell {
       max-width: 100%;
       padding: 1.25rem 1.1rem 1.4rem;
       border-radius: 16px;
       margin: 0 auto;
     }
   
     h1 {
       font-size: 1.6rem;
       line-height: 1.2;
     }
   
     .hint.inline-steps {
       font-size: 0.78rem;
     }
   
     label {
       font-size: 0.82rem;
     }
   
     input[type="text"],
     input[type="password"] {
       font-size: 0.9rem;
       padding: 0.55rem 7rem 0.55rem 0.7rem;
       box-sizing: border-box;
     }
   
     .handle-suffix {
       font-size: 0.9rem;
       right: 0.7rem;
     }
   
     button {
       width: 100%;
       justify-content: center;
       text-align: center;
     }
   
     .footer {
       margin-top: 1.2rem;
       display: flex;
       flex-direction: row;       
       align-items: center;
       justify-content: space-between;
       flex-wrap: nowrap;         
       gap: 0.6rem;
       width: 100%;
     }
   
     .version-badge {
       flex-shrink: 0;            
       font-size: 0.72rem;
     }
   
     .footer-link {
       margin-left: auto;         
       white-space: nowrap;       
       flex-shrink: 1;           
       font-size: 0.78rem;
     }
  }
   
   
   @media (max-width: 380px) {
     body {
       padding-inline: 0.6rem;
     }
   
     .shell {
       padding-inline: 1rem;
     }
   
     h1 {
       font-size: 1.45rem;
     }
   
     input[type="text"],
     input[type="password"] {
       font-size: 0.85rem;
     }
   }
   body[data-sigil-char]::before,
   body[data-sigil-char]::after {
     content: attr(data-sigil-char);
     position: fixed;
     font-size: 3rem;
     opacity: 0.35;
     text-shadow:
       0 4px 8px rgba(0,0,0,0.5),
       0 0 18px rgba(0,0,0,0.4);
     pointer-events: none;
     z-index: 0;
     bottom: 1.4rem;
     right: 1.4rem;
   }
   
   
   body[data-sigil-side="after"]::before {
     content: none !important;
   }
   body[data-sigil-side="before"]::after {
     content: none !important;
   }

  .footer {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;      
    margin-top: 1.5rem;
    font-size: 0.8rem;
  }
   
  .footer-left,
  .footer-right {
    text-decoration: none;
    font-weight: 600;
  }
  
    .footer-right {
    color: #8feaff;
  }
  
  .footer-right:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  
  .footer-left {
    position: relative;
    color: transparent;
    background: linear-gradient(
      120deg,
      #f97316,
      #facc15,
      #22c55e,
      #0ea5e9,
      #8b5cf6,
      #ec4899
    );
    -webkit-background-clip: text;
    background-clip: text;
    text-shadow:
      0 0 6px rgba(0, 0, 0, 0.65),
      0 0 12px rgba(0, 0, 0, 0.85);
  }
  
 .footer-left:hover {
    text-decoration: none;
  }
  
  
  .footer-left::before {
    content: "";
    position: absolute;
    inset: -0.25rem -0.35rem;
    border-radius: 999px;
    background: radial-gradient(circle, rgba(255,255,255,0.85), transparent 70%);
    opacity: 0.8;
    filter: blur(4px);
    z-index: -1;
    pointer-events: none;
  }
  
  
  .footer-left::after {
    content: "Lore...";
    position: absolute;
    left: 50%;
    bottom: 130%;
    transform: translateX(-50%) translateY(4px);
    padding: 0.25rem 0.5rem;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.95);
    color: #e5e7eb;
    font-size: 0.7rem;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.8);
    transition:
      opacity 0.15s ease-out,
      transform 0.15s ease-out;
  }
  
  .footer-left:hover::after {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
      
  
  </style>
  </head>
  <body${bodySigilAttrs} data-pride-theme="${theme.name}">
    <main class="shell">
      <h1><span>Seize your ${baseDomain}</span> bsky handle</h1>
      <p class="hint inline-steps">
        <span>1 Enter your current Bluesky handle.</span><br />
        <span>2 Pick a handle under ${baseDomain}.</span><br />
        <span>3 Save your secret key somewhere safe.</span>
      </p>

      <form id="claimForm">
        <div>
          <label for="currentHandle">Your current Bluesky handle:</label>
          <div class="handle-wrapper">
            <input
              id="currentHandle"
              name="currentHandle"
              type="text"
              placeholder="you.bsky.social"
              required
            />
          </div>
        </div>

        <div>
          <label for="desiredSubdomain">Handle you want:</label>
          <div class="handle-wrapper">
            <input
              id="desiredSubdomain"
              name="desiredSubdomain"
              type="text"
              placeholder="riotgrrrl"
              required
            />
            <span class="handle-suffix">.${baseDomain}</span>
          </div>
          <div class="hint">
            Your final handle will look like
            <code id="finalHandlePreview">riotgrrrl.${baseDomain}</code>
          </div>
        </div>

        <button type="submit" class="primary btn-claim">Claim this handle</button>
        <div id="secretKeyContainer" class="hint" style="display:none; margin-top:0.5rem;"></div>
      </form>

      <p
      id="secretKeyNote"
      class="hint"
      style="margin-top:1.75rem; display:none;"
      >
    
        We store only a hash of your secret key. If you lose the key, we can't recover it for you. That's the tradeoff for control.
      </p>
      <div id="claimStatus" class="hint" style="margin-top:0.35rem;"></div>

      <div class="footer">
        <a href="/a" class="footer-left" aria-label="About this project">?</a>
        <a href="/m" class="footer-right">Manage / Delete handles</a>
      </div>
                </main>
<script>
  const baseDomain = "${baseDomain}";
</script>

<script>
  const form = document.getElementById("claimForm");
  const statusEl = document.getElementById("claimStatus");
  const keyEl = document.getElementById("secretKeyContainer");
  const keyNoteEl = document.getElementById("secretKeyNote");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    statusEl.textContent = "";
    statusEl.innerHTML = "";
    keyEl.style.display = "none";
    keyEl.innerHTML = "";
    if (keyNoteEl) {
      keyNoteEl.style.display = "none";
    }

    const currentHandle = form.currentHandle.value;
    const desiredSubdomain = form.desiredSubdomain.value;

    const body = {
      handle: currentHandle,
      subdomain: desiredSubdomain
    };

    let res;
    try {
      res = await fetch("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (err) {
      statusEl.textContent = "Network error. Try again in a moment.";
      return;
    }

    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }

    if (!res.ok) {
      statusEl.innerHTML = data.error || "Could not register this handle.";
      return;
    }

    statusEl.innerHTML =
      '<p class="handle-instructions">' +
      'Your handle’s good to go. To use it on Bluesky, open the handle section in your account settings. ' +
      'Pick <strong>I have my own domain</strong>, jump to the <strong>No DNS Panel</strong> tab, ' +
      'paste in your new handle, hit <strong>Verify</strong>, then <strong>Update Handle</strong>. Easy.' +
      "</p>";

      if (data.secret_key) {
        const key = data.secret_key;
      
        keyEl.style.display = "block";
        keyEl.innerHTML =
          '<div class="secret-key-box">' +
            '<div class="secret-key-label">Your secret key</div>' +
            '<div class="secret-key-value">' +
              '<p>Click the key to copy:</p><code id="secret-key-value" title="Click to copy this key">' +
                key +
              "</code>" +
            "</div>" +
            '<p class="master-key-highlight">' +
              'Treat this like a master key for your DID at this website. It’s the ONLY way to manage or delete handles on ' +
              '<span class="secret-key-domain">' + baseDomain + "</span>, and there’s no recovery if it’s lost." +
            "</p>" +
          "</div>";
      
        if (keyNoteEl) {
          keyNoteEl.style.display = "block";
        }
      
        const keyCodeEl = document.getElementById("secret-key-value");
        if (keyCodeEl && navigator.clipboard) {
          keyCodeEl.style.cursor = "pointer";
      
          keyCodeEl.addEventListener("click", async () => {
            const originalText = keyCodeEl.textContent || key;
            try {
              await navigator.clipboard.writeText(key);
              keyCodeEl.textContent = "Copied!";
              setTimeout(() => {
                keyCodeEl.textContent = originalText;
              }, 1200);
            } catch {
              keyCodeEl.textContent = "Copy failed";
              setTimeout(() => {
                keyCodeEl.textContent = originalText;
              }, 1500);
            }
          });
        }
      }
    });

  const subInput = document.getElementById("desiredSubdomain");
  const preview = document.getElementById("finalHandlePreview");

  if (subInput && preview) {
    subInput.addEventListener("input", () => {
      const value = subInput.value.trim();
      if (value.length === 0) {
        preview.textContent = "riotgrrrl." + baseDomain;
      } else {
        preview.textContent = value + "." + baseDomain;
      }
    });
  }
  
</script>
<script>
(function () {
  const THEMES_URL = "/themes";

  function clearIntersexRing() {
    const old = document.getElementById("intersex-ring-style");
    if (old) old.remove();
  }

  function applyIntersexRing() {
    clearIntersexRing();
  
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
      + '<rect width="100" height="100" fill="#f7e11e"/>'
      + '<circle cx="50" cy="50" r="24" fill="none" stroke="#7b2fbf" stroke-width="10"/>'
      + '</svg>';
  
    const encoded = encodeURIComponent(svg);
  
    const placements = [
      { top: "1.6rem", left: "2.2rem" },
      { top: "1.6rem", right: "2.2rem" },
      { bottom: "2.2rem", left: "2.2rem" },
      { bottom: "2.2rem", right: "2.2rem" }
    ];
  
    const pos = placements[Math.floor(Math.random() * placements.length)];
  
    const css =
      "body::before{" +
      "content:'';" +
      "position:fixed;" +
      "width:160px;" +
      "height:160px;" +
      "background-image:url(\"data:image/svg+xml," + encoded + "\");" +
      "background-repeat:no-repeat;" +
      "background-size:contain;" +
      "opacity:0.82;" +
      "pointer-events:none;" +
      "z-index:0;" +
      Object.entries(pos)
        .map(([k, v]) => k + ":" + v + ";")
        .join("") +
      "}";
  
    const style = document.createElement("style");
    style.id = "intersex-ring-style";
    style.textContent = css;
    document.head.appendChild(style);
  }
  
  async function loadThemes() {
    try {
      const res = await fetch(THEMES_URL, { credentials: "omit" });
      if (!res.ok) return;

      const data = await res.json();
      const list = Array.isArray(data) ? data : Object.values(data);
      if (!list.length) return;

      const theme = list[Math.floor(Math.random() * list.length)];
      const id = (theme.id || theme.name || "").toLowerCase();

      // always apply background
      if (theme.background) {
        document.body.style.background = theme.background;
      }

      // intersex ring takes over completely
      const isIntersex = /intersex/i.test(id);
      if (isIntersex) {
              applyIntersexRing();
        return;
      }

      // fallback sigil
      const sigil = document.body.getAttribute("data-sigil-char");
      if (!sigil) return;

      // apply default opacity
      document.body.style.setProperty("--sigil-opacity", "0.35");

      // special sigils
      if (id.includes("lesbian")) {
        document.body.style.setProperty("--sigil-opacity", "0.9");
        document.body.style.setProperty("--sigil-top", "auto");
        document.body.style.setProperty("--sigil-left", "auto");
        document.body.style.setProperty("--sigil-bottom", "2rem");
        document.body.style.setProperty("--sigil-right", "2rem");
        return;
      }

      if (id.includes("gay")) {
        document.body.style.setProperty("--sigil-opacity", "0.9");
        document.body.style.setProperty("--sigil-bottom", "auto");
        document.body.style.setProperty("--sigil-right", "auto");
        document.body.style.setProperty("--sigil-top", "2rem");
        document.body.style.setProperty("--sigil-left", "2rem");
        return;
      }

      if (id.includes("autism")) {
        document.body.style.setProperty("--sigil-opacity", "0.9");
        document.body.style.setProperty("--sigil-bottom", "auto");
        document.body.style.setProperty("--sigil-left", "auto");
        document.body.style.setProperty("--sigil-top", "2rem");
        document.body.style.setProperty("--sigil-right", "2rem");
        return;
      }
    } catch (err) {
      console.error(err);
    }
  }

  document.addEventListener("DOMContentLoaded", loadThemes);
})();
</script>

    ${buildSigilOverrideStyle(theme)}
  </body>
</html>`;
}
//const MANAGE_HTML = `<!doctype html>

function renderManagePage({ baseDomain, version, theme }) {
  const intersexExtraCss =
    theme && theme.name === "intersex" ? buildIntersexRingCss() : "";

  const sigilChar =
    theme && typeof theme.sigil === "string" && theme.sigil.length
      ? theme.sigil
      : "";

  const sigilSide =
    theme && theme.sigilSide === "after" ? "after" : "before";

  const bodySigilAttrs = sigilChar
    ? ` data-sigil-char="${sigilChar}" data-sigil-side="${sigilSide}"`
    : "";
    

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Manage handles – ${baseDomain}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #020617;
    --panel: rgba(15,23,42,0.96);
    --accent: #38bdf8;
    --accent2: #a855f7;
    --text: #f9fafb;
    --muted: #9ca3af;
    --border: rgba(148,163,184,0.7);
  }

  body {
    margin: 0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: ${theme.background};
    background-attachment: fixed;
    background-repeat: no-repeat;
    background-size: cover;
    color: var(--text);
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    position: relative;
  
  }

  .shell {
    max-width: 520px;
    width: 100%;
    background: var(--panel);
    border-radius: 16px;
    border: 1px solid var(--border);
    padding: 1.5rem 1.75rem;
    box-shadow: 0 18px 40px rgba(15,23,42,0.9);

    position: relative;  
    z-index: 5;
  }

  h1 {
    margin: 0 0 0.5rem 0;
    font-weight: 650;
  }
  p {
    margin: 0.2rem 0 0.4rem 0;
    color: var(--muted);
    font-size: 0.9rem;
  }
  label {
    display: block;
    margin-top: 0.8rem;
    font-size: 0.85rem;
  }
  input[type="text"] {
    width: 100%;
    padding: 0.45rem 0.6rem;
    margin-top: 0.35rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(15,23,42,0.85);
    color: var(--text);
    font-size: 0.9rem;
  }
  button {
    margin-top: 0.8rem;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.6);
    background: radial-gradient(circle at top left,#38bdf8,#6366f1);
    color: #0b1120;
    font-size: 0.9rem;
    padding: 0.4rem 1.1rem;
    cursor: pointer;
    font-weight: 550;
  }
  button.danger {
    background: radial-gradient(circle at top left,#fb7185,#ea580c);
    color: #0b1120;
  }
  .status {
    margin-top: 0.6rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .handle-row {
    margin-top: 0.8rem;
    padding: 0.7rem 0.75rem;
    background: rgba(15,23,42,0.95);
    border-radius: 10px;
    border: 1px solid rgba(51,65,85,0.9);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  .handle-row code {
    font-size: 0.85rem;
  }
  
  ${intersexExtraCss}

  @media (max-width: 640px) {
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100dvh;
      padding: 1rem;
      box-sizing: border-box;
    }
      
    .shell {
      max-width: 100%;
      margin: 0 auto;
      padding: 1.25rem 1.1rem 1.4rem;
      border-radius: 16px;
    }

    h1 {
      font-size: 1.5rem;
      line-height: 1.2;
    }

    p {
      font-size: 0.86rem;
    }

    label {
      font-size: 0.8rem;
    }

    input[type="text"] {
      font-size: 0.9rem;
      padding: 0.45rem 0.7rem;
    }

    button {
      width: 100%;
      justify-content: center;
      text-align: center;
    }

    .handle-row {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.4rem;
    }

    .handle-row button {
      width: 100%;
      text-align: center;
    }
  }
  #status.is-hidden {
    display: none;
  }
  
  @media (max-width: 380px) {
    body {
      padding-inline: 0.6rem;
    }

    .shell {
      padding-inline: 1rem;
    }
  }
  .shell input[type="text"] {
    max-width: 100%;
    box-sizing: border-box;
  }
body[data-sigil-char]::before,
body[data-sigil-char]::after {
  content: attr(data-sigil-char);
  position: fixed;
  font-size: 3rem;
  opacity: 0.35;
  text-shadow:
    0 4px 8px rgba(0,0,0,0.5),
    0 0 18px rgba(0,0,0,0.4);
  pointer-events: none;
  z-index: 0;
  bottom: 1.4rem;
  right: 1.4rem;
}

body[data-sigil-side="after"]::before {
  content: none !important;
}
body[data-sigil-side="before"]::after {
  content: none !important;
}

</style>
</head>
<body${bodySigilAttrs}>
  <div class="shell">
    <h1>Manage your handles</h1>
    <p>Enter your secret key to manage/delete your registered handles on <strong>${baseDomain}</strong>.</p>

    <label for="secret-input">Secret key</label>
    <input type="text" id="secret-input" placeholder="your secret key" />

    <button id="load-btn">Show my handles</button>

    <div class="status is-hidden" id="status">No lookup yet.</div>

    <div id="results"></div>
    <div style="margin-top:1rem; text-align:center;">
  <a href="/" 
     style="
       color:#ffffffcc;
       text-decoration:none;
       font-size:0.9rem;
       display:inline-block;
       margin-top:0.4rem;
     ">
    ← Return to main page
  </a>
</div>

  </div>

<script>
let currentDid = null;
document.getElementById("load-btn").onclick = function () {
  loadHandles();
};

async function loadHandles() {
  var secret = document.getElementById("secret-input").value.trim();
  var status = document.getElementById("status");
  var results = document.getElementById("results");

  status.classList.remove("is-hidden"); 

  if (!secret) {
    status.textContent = "Please enter your secret key.";
    return;
  }
  status.classList.remove("is-hidden");
  status.textContent = "Loading…";
  results.innerHTML = "";
  var res = await fetch("/m", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list", secret: secret })
  });
  if (!res.ok) {
    status.textContent = "Invalid secret or no handles found.";
    return;
  }
  var data = await res.json();
  currentDid = data.did || null;

  var count = (data.handles || []).length;
  status.textContent = "DID: " + data.did + " • " + data.handles.length + " handle(s)";
  data.handles.forEach(function (h) {
    var row = document.createElement("div");
    row.className = "handle-row";
    var span = document.createElement("span");
    span.innerHTML = "<code>" + h.sub + ".${baseDomain}</code>";
    var btn = document.createElement("button");
    btn.className = "danger";
    btn.textContent = "Delete";
    btn.onclick = function () { deleteHandle(secret, h.sub, row); };
    row.appendChild(span);
    row.appendChild(btn);
    results.appendChild(row);
  });
}

async function deleteHandle(secret, sub, rowEl) {
  if (!confirm("Delete " + sub + ".${baseDomain} ?")) return;
  var res = await fetch("/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: secret, sub: sub })
  });
  if (!res.ok) {
    alert("Failed to delete handle. HTTP " + res.status);
    return;
  }
  rowEl.remove();
  var results = document.getElementById("results");
  var remaining = results.querySelectorAll(".handle-row").length;
  var status = document.getElementById("status");

  if (remaining === 0) {
    status.textContent = "No handles currently registered for this secret key.";
  } else {
    status.textContent =
      (currentDid ? "DID: " + currentDid + " • " : "") +
      remaining +
      " handle(s)";
  }
}
</script>
${buildSigilOverrideStyle(theme)}
</body>
</html>`;
}
//---------------------------
//      ABOUT PAGE
//---------------------------
function renderAboutPage({ baseDomain, version, theme }) {
  const background = theme && theme.background ? theme.background : "#111827";

  const sigilChar =
    theme && typeof theme.sigil === "string" && theme.sigil.length
      ? theme.sigil
      : "";

  const sigilSide =
    theme && theme.sigilSide === "after" ? "after" : "before";

  const bodySigilAttrs = sigilChar
    ? ` data-sigil-char="${sigilChar}" data-sigil-side="${sigilSide}"`
    : "";


  const intersexCss =
    theme && theme.name === "intersex" && typeof buildIntersexRingCss === "function"
      ? buildIntersexRingCss()
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>About ${baseDomain}</title>

  <style>
    :root {
      --fg-main: #ffffff;
      --fg-muted: rgba(255,255,255,0.78);
      --card-bg: rgba(0,0,0,0.45);
      --card-border: rgba(255,255,255,0.22);
      --card-shadow: 0 8px 22px rgba(0,0,0,0.4);
    }

    body {
      margin: 0;
      padding: 0;
      min-height: 100dvh;
      display: flex;
      justify-content: center;
      align-items: center;
      color: var(--fg-main);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: ${background};
      background-size: cover;
      background-position: center;
    }

    .shell {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      padding: 2rem;
      border-radius: 14px;
      max-width: 560px;
      width: 90%;
      box-shadow: var(--card-shadow);
      text-align: left;
    }

    h1 {
      margin-top: 0;
      margin-bottom: 1rem;
      font-size: 1.7rem;
      font-weight: 650;
      letter-spacing: 0.01em;
    }

    .brand-rainbow {
      background: linear-gradient(
        90deg,
        #f97316,
        #facc15,
        #22c55e,
        #0ea5e9,
        #8b5cf6,
        #ec4899
      );
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      text-shadow: 0 0 18px rgba(0,0,0,0.65);
      font-weight: 600;
    }

    p {
      line-height: 1.5;
      margin: 0.9rem 0;
      font-size: 1rem;
      color: var(--fg-muted);
      text-align: justify;
    }

    .back-link {
      display: inline-block;
      margin-top: 1.6rem;
      color: #8feaff;
      text-decoration: none;
      font-size: 0.9rem;
    }

    .back-link:hover {
      text-decoration: underline;
    }

    @media (max-width: 620px) {
      .shell {
        padding: 1.5rem;
      }
      h1 {
        font-size: 1.45rem;
      }
    }

    ${intersexCss}
    body[data-sigil-char]::before,
    body[data-sigil-char]::after {
      content: attr(data-sigil-char);
      position: fixed;
      font-size: 3rem;
      opacity: 0.35;
      text-shadow:
        0 4px 8px rgba(0,0,0,0.5),
        0 0 18px rgba(0,0,0,0.4);
      pointer-events: none;
      z-index: 0;
      bottom: 1.4rem;
      right: 1.4rem;
    }

    body[data-sigil-side="after"]::before {
      content: none !important;
    }
    body[data-sigil-side="before"]::after {
      content: none !important;
    }

  </style>
</head>

<body${bodySigilAttrs}>
  <div class="shell">
    <h1>About this project</h1>

    <p>
      ${baseDomain} is a small, independent identity
      side-domain built for people who want a little more control over how their
      Bluesky handle looks. It isn't a platform or a service. It's a tool: you pick
      a subdomain, it maps to your DID, and you control it yourself with a secret key.
    </p>

    <p>
      There's no account system, no recovery process, and no personal data stored.
      The system keeps a hash of your secret key, not the key itself. If it's lost,
      there isn't a reset mechanism by design. The goal is to stay simple,
      privacy-respecting, and self-governing.
    </p>

    <p>
      The backgrounds rotate through a collection of pride and awareness flags.
      Partly because they're beautiful, partly because the communities behind those
      flags are usually the ones exploring independent identity tech long before
      it becomes mainstream. The themes don't track anything and don't imply
      anything about whoever's visiting. They're just meant to make the space feel
      welcoming and unmistakably not corporate.
    </p>

    <p>
      There's no support inbox and no formal downtime guarantees. If something breaks,
      it's usually fixed quickly, but the intent is for the system to run mostly on
      its own without needing anyone to intervene.
    </p>

    <p>
      If you're using this: glad it's useful. That's the whole story.
    </p>

    <a class="back-link" href="/">← Return to the main page</a>
  </div>
  ${buildSigilOverrideStyle(theme)}
</body>
</html>`;
}

// ---------------------------------------------------------
// Admin HTML
// ---------------------------------------------------------

function renderAdminLoginPage({ theme, errorHtml = "" }) {
  const background =
    theme && typeof theme.background === "string" && theme.background.trim()
      ? theme.background
      : "#020617";

  const sigilChar =
    theme && typeof theme.sigil === "string" && theme.sigil.length
      ? theme.sigil
      : "";

  const sigilSide =
    theme && theme.sigilSide === "after" ? "after" : "before";

  const bodySigilAttrs = sigilChar
    ? ` data-sigil-char="${sigilChar}" data-sigil-side="${sigilSide}"`
    : "";

  const intersexCss =
    theme && theme.name === "intersex"
      ? buildIntersexRingCss()
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>anarchy.lgbt — admin login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: ${background};
      background-attachment: fixed;
      background-repeat: no-repeat;
      background-size: cover;
      color: #f9fafb;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 1.5rem;
      position: relative;
    }
    .shell {
      max-width: 380px;
      width: 100%;
      background: rgba(15,23,42,0.96);
      border-radius: 18px;
      border: 1px solid rgba(148,163,184,0.7);
      padding: 1.5rem 1.75rem;
      box-shadow: 0 22px 60px rgba(15,23,42,0.9);
      position: relative;
      z-index: 1;
    }
    h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
    p { margin: 0.4rem 0; font-size: 0.9rem; color: #9ca3af; }
    label { display: block; margin-top: 0.8rem; font-size: 0.85rem; }
    input[type="password"] {
      width: 100%;
      margin-top: 0.35rem;
      padding: 0.55rem 0.7rem;
      border-radius: 10px;
      border: 1px solid rgba(148,163,184,0.8);
      background: rgba(15,23,42,0.9);
      color: #f9fafb;
      font-size: 0.95rem;
    }
    button {
      margin-top: 0.9rem;
      border-radius: 999px;
      border: none;
      padding: 0.55rem 1.4rem;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      background: linear-gradient(135deg, #fb7185, #e879f9);
      color: #111827;
      box-shadow: 0 10px 25px rgba(15,23,42,0.9);
    }
    .error { color: #fecaca; font-size: 0.8rem; margin-top: 0.5rem; }

    ${intersexCss}

    body[data-sigil-char]::before,
    body[data-sigil-char]::after {
      content: attr(data-sigil-char);
      position: fixed;
      font-size: 3rem;
      opacity: 0.35;
      text-shadow:
        0 4px 8px rgba(0,0,0,0.5),
        0 0 18px rgba(0,0,0,0.4);
      pointer-events: none;
      z-index: 0;
      bottom: 1.4rem;
      right: 1.4rem;
    }
    body[data-sigil-side="after"]::before {
      content: none !important;
    }
    body[data-sigil-side="before"]::after {
      content: none !important;
    }
  </style>
</head>
<body${bodySigilAttrs}>
  <main class="shell">
    <h1>admin login</h1>
    ${errorHtml || ""}
    <p>Enter the admin pass configured on the Worker.</p>
    <form method="post" action="/gg">
      <label for="token">Admin pass</label>
      <input id="token" name="token" type="password" autocomplete="current-password" />
      <button type="submit">Enter</button>
    </form>
  </main>
  ${buildSigilOverrideStyle(theme)}
</body>
</html>`;
}

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>anarchy.lgbt – Handle Registry Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    --bg: #050510;
    --panel: rgba(15,15,35,0.95);
    --accent: #ff9ad5;
    --accent2: #7ad7ff;
    --danger: #ff5f7a;
    --text: #f7f7ff;
    --muted: #9ca3af;
    --border: rgba(148,163,184,0.5);
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 1.5rem;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: radial-gradient(circle at top, #1f2937 0, #020617 55%, #000 100%);
    color: var(--text);
  }
  h1, h2, h3 {
    margin: 0 0 0.5rem 0;
    font-weight: 650;
  }
  h1 span.version {
    font-size: 0.9rem;
    color: var(--muted);
    margin-left: 0.5rem;
  }
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.8fr);
    gap: 1rem;
  }
  .card {
    background: var(--panel);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    padding: 1rem 1.25rem 1.1rem;
    box-shadow: 0 18px 40px rgba(15,23,42,0.7);
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.6);
    font-size: 0.75rem;
    color: var(--muted);
  }
  .tag-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: linear-gradient(135deg,#5eead4,#a855f7);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .vip-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.05rem 0.55rem;
    border-radius: 999px;
    border: 1px solid rgba(251, 191, 36, 0.8);
    font-size: 0.7rem;
    font-weight: 600;
    background: radial-gradient(circle at top left, #facc15, #f97316);
    color: #111827;
    white-space: nowrap;
    margin-top: 0.25rem;
  }
  .vip-badge-star {
    font-size: 0.8rem;
  }
  .blocked-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.05rem 0.55rem;
    border-radius: 999px;
    border: 1px solid rgba(239, 68, 68, 0.75);
    font-size: 0.7rem;
    font-weight: 600;
    background: radial-gradient(circle at top left, #fca5a5, #ef4444);
    color: #111827;
    white-space: nowrap;
    margin-top: 0.25rem;
  }
  .blocked-badge-icon {
    font-size: 0.8rem;
  }
  .metrics-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-bottom: 1rem;
  }
  .metric-card {
    padding: 0.4rem 0.8rem;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: rgba(15, 23, 42, 0.92);
    font-size: 0.75rem;
    min-width: 90px;
  }
  .metric-label {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.65rem;
    color: var(--muted);
    margin-bottom: 0.2rem;
  }
  .metric-value {
    font-weight: 650;
    font-size: 0.9rem;
  }
  .metric-vip {
    border-color: rgba(250, 204, 21, 0.8);
  }
  .metric-blocked {
    border-color: rgba(248, 113, 113, 0.85);
  }
  .row-vip {
    background: radial-gradient(circle at left, rgba(250, 204, 21, 0.12), transparent 55%);
  }
  .row-blocked {
    background: radial-gradient(circle at left, rgba(248, 113, 113, 0.16), transparent 55%);
  }
  .row-vip.row-blocked {
    background:
      radial-gradient(circle at left, rgba(248, 113, 113, 0.16), transparent 55%),
      radial-gradient(circle at right, rgba(250, 204, 21, 0.12), transparent 55%);
  }
  .primary-handle {
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 0.15rem;
  }
  button {
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.6);
    background: radial-gradient(circle at top left,#38bdf8,#6366f1);
    color: #0b1120;
    font-size: 0.82rem;
    padding: 0.3rem 0.85rem;
    cursor: pointer;
    font-weight: 550;
  }
  button.danger {
    background: radial-gradient(circle at top left,#fb7185,#ea580c);
    color: #0b1120;
  }
  button.ghost {
    background: transparent;
    color: var(--muted);
  }
  input[type="text"] {
    width: 100%;
    padding: 0.35rem 0.5rem;
    border-radius: 999px;
    border: 1px solid rgba(148,163,184,0.6);
    background: rgba(15,23,42,0.8);
    color: var(--text);
    font-size: 0.82rem;
  }
  .field-row {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    align-items: center;
  }
  .pill-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }
  .pill {
    border-radius: 999px;
    padding: 0.13rem 0.6rem;
    font-size: 0.75rem;
    border: 1px solid rgba(148,163,184,0.6);
    background: rgba(15,23,42,0.9);
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .pill button {
    border-radius: 999px;
    border: none;
    background: transparent;
    color: var(--muted);
    padding: 0;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .pill button:hover {
    color: var(--danger);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
  }
  th, td {
    padding: 0.35rem 0.4rem;
    border-bottom: 1px solid rgba(30,64,175,0.6);
    text-align: left;
  }
  th {
    color: var(--muted);
    font-weight: 500;
  }
  tbody tr:hover {
    background: rgba(15,23,42,0.85);
  }
  .muted {
    color: var(--muted);
  }
  .status-bar {
    font-size: 0.78rem;
    margin-top: 0.4rem;
    color: var(--muted);
  }
  @media (max-width: 900px) {
    .grid {
      grid-template-columns: minmax(0,1fr);
    }
  }

  @media (max-width: 640px) {
    body {
      padding: 0.9rem;
    }

    h1 {
      font-size: 1.3rem;
    }

    .grid {
      gap: 0.75rem;
    }

    .card {
      padding: 0.9rem 1rem 1rem;
    }

    .metrics-strip {
      gap: 0.45rem;
    }

    .metric-card {
      flex: 1 1 45%;
      min-width: 0;
      padding: 0.35rem 0.6rem;
    }

    .field-row {
      flex-direction: column;
      align-items: stretch;
    }

    .field-row button {
      width: 100%;
      text-align: center;
    }

    #registry-table,
    #registry-table thead,
    #registry-table tbody,
    #registry-table tr,
    #registry-table th,
    #registry-table td {
      font-size: 0.76rem;
    }

    #registry-table,
    #activity-body {
      display: block;
    }

    #registry-table {
      overflow-x: auto;
      white-space: nowrap;
    }
  }

  @media (max-width: 380px) {
    body {
      padding: 0.75rem;
    }
  }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
    <div>
      <h1>anarchy.lgbt registry <span class="version">v<span id="version-span"></span></span></h1>
      <div class="muted">Admin console • all routes under <code>/gg</code></div>
    </div>
    <div class="controls">
      <button class="ghost" id="refresh-btn">Refresh</button>
      <button class="danger" id="logout-btn">Logout</button>
    </div>
  </div>

  <div class="metrics-strip">
    <div class="metric-card">
      <div class="metric-label">DIDs</div>
      <div class="metric-value" id="metric-dids">0</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Handles</div>
      <div class="metric-value" id="metric-handles">0</div>
    </div>
    <div class="metric-card metric-vip">
      <div class="metric-label">VIP DIDs</div>
      <div class="metric-value" id="metric-vips">0</div>
    </div>
    <div class="metric-card metric-blocked">
      <div class="metric-label">Blocked DIDs</div>
      <div class="metric-value" id="metric-blocked">0</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-header">
        <div>
          <h2>Registry</h2>
          <div class="muted">All DIDs and their handles</div>
        </div>
        <span class="tag"><span class="tag-dot"></span> live</span>
      </div>

      <div class="field-row" style="margin-top:0.35rem;">
        <input
          type="text"
          id="registry-filter"
          placeholder="Filter by DID or handle…"
        />
      </div>

      <div class="status-bar" id="registry-status">Loading registry…</div>
      <div style="max-height:380px;overflow:auto;margin-top:0.5rem;">
        <table id="registry-table">
          <thead>
            <tr>
              <th>DID</th>
              <th>Handles</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="registry-body"></tbody>
        </table>
      </div>

      <div class="card" style="margin-top:0.9rem;">
        <div class="card-header" style="margin-bottom:0.4rem;">
          <div>
            <h3 style="font-size:0.95rem;">Handle → DID</h3>
            <div class="muted">Quick resolver for Bluesky handles</div>
          </div>
        </div>
        <div class="field-row">
          <input
            type="text"
            id="resolve-handle-input"
            placeholder="someone.bsky.social or @someone"
          />
          <button id="resolve-handle-btn">Resolve</button>
        </div>
        <div class="status-bar" id="resolve-status" style="margin-top:0.6rem;">
          Enter a handle and click Resolve.
        </div>
        <div class="status-bar" id="resolve-result" style="margin-top:0.3rem;"></div>
      </div>

      <div style="margin-top:1rem;border-top:1px dashed rgba(148,163,184,0.5);padding-top:0.75rem;">
        <div class="card-header" style="padding:0;">
          <div>
            <h3 style="font-size:0.95rem;">Recent activity</h3>
            <div class="muted">Latest registrations & deletions</div>
          </div>
          <button class="ghost" id="activity-refresh-btn">Reload</button>
        </div>
        <div style="max-height:180px;overflow:auto;margin-top:0.4rem;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>DID</th>
                <th>Handle</th>
                <th>PDS</th>
              </tr>
            </thead>
            <tbody id="activity-body"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <h2>Policy controls</h2>
          <div class="muted">VIPs, blocklists, and limits</div>
        </div>
      </div>

      <div>
        <h3 style="font-size:0.95rem;">VIP DIDs</h3>
        <div class="muted">VIPs bypass handle-count limits.</div>
        <div class="field-row">
          <input type="text" id="vip-input" placeholder="did:plc:examplevip" />
          <button id="vip-add-btn">Add VIP</button>
        </div>
        <div class="pill-list" id="vip-list"></div>
      </div>


      <div style="margin-top:1.1rem;">
        <h3 style="font-size:0.95rem;">Blocked DIDs</h3>
        <div class="muted">Completely forbidden from registering.</div>
        <div class="field-row">
          <input type="text" id="block-did-input" placeholder="did:plc:blockme" />
          <button id="block-did-add-btn">Block DID</button>
        </div>
        <div class="pill-list" id="block-did-list"></div>
      </div>

      <div style="margin-top:1.1rem;">
        <h3 style="font-size:0.95rem;">Blocked PDS hosts</h3>
        <div class="muted">Block registrations coming from these hosts.</div>
        <div class="field-row">
          <input type="text" id="block-pds-input" placeholder="pds.example.com" />
          <button id="block-pds-add-btn">Block PDS</button>
        </div>
        <div class="pill-list" id="block-pds-list"></div>
      </div>

      <div style="margin-top:1.1rem;">
        <div class="card-header" style="padding:0; margin-bottom:0.25rem;">
          <div>
            <h3 style="font-size:0.95rem;">Blocked handle keywords</h3>
            <div class="muted">
              Any handle containing these substrings will be rejected. Use for slurs and other banned terms.
            </div>
          </div>
          <button
            type="button"
            class="ghost"
            id="blocked-keyword-toggle-btn"
            style="font-size:0.75rem; padding:0.2rem 0.7rem;"
          >
            Hide list
          </button>
        </div>

        <div class="field-row">
          <input
            type="text"
            id="blocked-keyword-input"
            placeholder="comma-separated list. e.g. slur1, slur2, banned word"
          />
          <button id="blocked-keyword-add-btn">Block keyword</button>
        </div>

        <div class="pill-list" id="blocked-keyword-list"></div>
      </div>

      <div style="margin-top:1.1rem;">
      <h3 style="font-size:0.95rem;">Reserved handles</h3>
      <div class="muted">
        These subdomains cannot be claimed by users and can be assigned manually by you.
      </div>
      <div class="field-row">
        <input type="text" id="reserved-input" placeholder="goddess" />
        <button id="reserved-add-btn">Reserve</button>
      </div>
      <div class="pill-list" id="reserved-list"></div>
    </div>
    <!-- Assign reserved handle to a DID -->
    <div
      style="
        margin-top:0.9rem;
        border-top:1px dashed rgba(148,163,184,0.5);
        padding-top:0.7rem;
      "
    >
      <div class="muted" style="margin-bottom:0.4rem;">
        Assign a reserved handle directly to a DID.
      </div>

      <div class="field-row">
        <input
          type="text"
          id="assign-did-input"
          placeholder="did:plc:example"
        />
      </div>

      <div class="field-row" style="margin-top:0.45rem;">
        <input
          type="text"
          id="assign-sub-input"
          placeholder="reserved sub (e.g. goddess)"
        />
        <button id="assign-reserved-btn">Assign</button>
      </div>

      <!-- NEW: per-assignment status + secret display -->
      <div class="status-bar" id="assign-reserved-status" style="margin-top:0.6rem;">
        <!-- per-assignment status goes here -->
      </div>
      <div class="status-bar" id="assign-reserved-secret" style="margin-top:0.25rem;">
        <!-- secret key note goes here -->
      </div>

      <!-- Existing policy status line remains, just moved slightly down -->
      <div class="status-bar" id="policy-status" style="margin-top:0.75rem;">
        Loading policy…
      </div>

      <div style="margin-top:1.1rem; border-top:1px dashed rgba(148,163,184,0.5); padding-top:0.75rem;">
        <h3 style="font-size:0.95rem;">Traffic overview</h3>

        <div class="muted" style="margin-top:0.35rem;">
          Registrations per hour (global):
          <span id="metric-reg-hour">–</span>
        </div>

        <div class="muted" style="margin-top:0.35rem;">
          Top PDS hosts by attempts:
          <span id="metric-top-pds">–</span>
        </div>

        <div class="muted" style="margin-top:0.35rem;">
          Recent IP spikes:
          <span id="metric-ip-spikes">–</span>
        </div>
      </div>
      <!-- Backups: export / import config + registry -->
      <div
        style="
          margin-top:1.1rem;
          border-top:1px dashed rgba(148,163,184,0.5);
          padding-top:0.8rem;
        "
      >
        <h3 style="font-size:0.95rem;">Backups</h3>
        <div class="muted">
          Export or import configuration and registry data.
        </div>
  
        <div class="field-row" style="margin-top:0.6rem;">
          <button id="export-config-btn">Download config JSON</button>
          <button id="export-registry-json-btn">Registry JSON</button>
          <button id="export-registry-csv-btn">Registry CSV</button>
        </div>
  
        <div class="field-row" style="margin-top:0.6rem;">
          <input type="file" id="config-import-file" accept="application/json" />
          <button id="config-import-btn">Import config JSON</button>
        </div>
  
        <div class="field-row" style="margin-top:0.4rem;">
          <input type="file" id="registry-import-file" accept="application/json" />
          <button id="registry-import-btn">Import registry JSON</button>
        </div>
  
        <div class="status-bar" id="backup-status" style="margin-top:0.5rem;">
          No backup actions yet.
        </div>
      </div>
  
    </div>

  </div>

<script>
  const VERSION = "${VERSION}";
  let registryData = [];
  let vipDidsMap = {};
  let blockDidsMap = {};

  document.getElementById("version-span").textContent = VERSION || "";

  document.getElementById("logout-btn").onclick = function () {
    window.location.href = "/gg/logout";
  };

  document.getElementById("refresh-btn").onclick = function () {
  loadRegistry();
  loadPolicy();
  loadActivity();
  loadTrafficMetrics();
  };

  document.getElementById("activity-refresh-btn").onclick = function () {
    loadActivity();
  };

  async function loadRegistry() {
    const status = document.getElementById("registry-status");
    const tbody = document.getElementById("registry-body");
    status.textContent = "Loading registry…";
    tbody.innerHTML = "";
  
    try {
      const res = await fetch("/gg/dids");
  
      if (!res.ok) {
        status.textContent = "Failed to load registry. HTTP " + res.status;
        registryData = [];
        updateMetrics();
        return;
      }
  
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.error("Error parsing /gg/dids JSON:", e);
        status.textContent = "Failed to parse registry JSON.";
        registryData = [];
        updateMetrics();
        return;
      }
  
      const list = Array.isArray(data.dids)
        ? data.dids
        : (Array.isArray(data) ? data : []);
  
      registryData = list;
      status.textContent = "Total DIDs: " + list.length;
      renderRegistryTable(list);
      updateMetrics();
    } catch (err) {
      console.error("Network or JS error loading registry:", err);
      status.textContent = "Failed to load registry (network or script error). Check console.";
      registryData = [];
      updateMetrics();
    }
  }
  
  function renderRegistryTable(list) {
    const tbody = document.getElementById("registry-body");
    tbody.innerHTML = "";

    list.forEach(function (entry) {
      const tr = document.createElement("tr");

      const isVip = vipDidsMap && entry.did && vipDidsMap[entry.did];
      const isBlocked = blockDidsMap && entry.did && blockDidsMap[entry.did];

      if (isVip) tr.classList.add("row-vip");
      if (isBlocked) tr.classList.add("row-blocked");

      const didTd = document.createElement("td");
      const didMain = document.createElement("div");
      didMain.textContent = entry.did || "";
      didTd.appendChild(didMain);

      // ⭐ NEW: show primary/active handle under the DID
      const handlesArr = Array.isArray(entry.handles) ? entry.handles : [];
      if (handlesArr.length > 0) {
        const primary = handlesArr[0]; // treat first as "current / active"
        const primaryDiv = document.createElement("div");
        primaryDiv.className = "primary-handle";
        primaryDiv.innerHTML =
        "<code>" + (primary.sub || "") + ".anarchy.lgbt</code>";
              didTd.appendChild(primaryDiv);
      }
  

      if (isVip) {
        const badge = document.createElement("span");
        badge.className = "vip-badge";
        const starSpan = document.createElement("span");
        starSpan.className = "vip-badge-star";
        starSpan.textContent = "★";
        const labelSpan = document.createElement("span");
        labelSpan.textContent = "VIP";
        badge.appendChild(starSpan);
        badge.appendChild(labelSpan);
        didTd.appendChild(badge);
      }

      if (isBlocked) {
        const badgeB = document.createElement("span");
        badgeB.className = "blocked-badge";
        const iconSpan = document.createElement("span");
        iconSpan.className = "blocked-badge-icon";
        iconSpan.textContent = "⛔";
        const labelSpanB = document.createElement("span");
        labelSpanB.textContent = "Blocked";
        badgeB.appendChild(iconSpan);
        badgeB.appendChild(labelSpanB);
        didTd.appendChild(badgeB);
      }

      const handlesTd = document.createElement("td");
      handlesTd.innerHTML = (entry.handles || [])
        .map(function (h) {
          return "<code>" + h.sub + ".anarchy.lgbt</code>";
        })
        .join("<br>");

      const actionsTd = document.createElement("td");

      // 🔴 BULK DELETE BUTTON
      if (entry.did) {
        const bulkBtn = document.createElement("button");
        bulkBtn.textContent = "Delete ALL";
        bulkBtn.className = "danger";
        bulkBtn.style.display = "block";
        bulkBtn.style.marginBottom = "0.3rem";
        bulkBtn.onclick = () => adminDeleteAllForDid(entry.did);
        actionsTd.appendChild(bulkBtn);
      }
      
      // Per-handle delete buttons (unchanged)
      (entry.handles || []).forEach(h => {
        const btn = document.createElement("button");
        btn.textContent = "Delete " + h.sub;
        btn.className = "danger";
        btn.style.display = "block";
        btn.style.marginTop = "0.15rem";
        btn.onclick = () => adminDeleteHandle(entry.did, h.sub, tr);
        actionsTd.appendChild(btn);
      });
        
      tr.appendChild(didTd);
      tr.appendChild(handlesTd);
      tr.appendChild(actionsTd);
      tbody.appendChild(tr);
    });
  }

  async function adminDeleteHandle(did, sub) {
    if (!confirm('Delete handle "' + sub + '" for ' + did + ' ?')) return;
    const res = await fetch("/gg/delete-handle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did: did, sub: sub })
    });
    if (!res.ok) {
      alert("Failed to delete. HTTP " + res.status);
      return;
    }
    loadRegistry();
    loadActivity();
  }
  async function assignReservedHandle() {
    const didInput = document.getElementById("assign-did-input");
    const subInput = document.getElementById("assign-sub-input");
    const status = document.getElementById("assign-reserved-status");
    const secretEl = document.getElementById("assign-reserved-secret");

    if (!didInput || !subInput || !status || !secretEl) return;

    const did = (didInput.value || "").trim();
    const sub = (subInput.value || "").trim().toLowerCase();

    status.textContent = "";
    secretEl.textContent = "";

    if (!did || !sub) {
      status.textContent = "Enter both a DID and a reserved subdomain.";
      return;
    }

    status.textContent = "Assigning…";

    let res;
    try {
      res = await fetch("/gg/assign-handle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ did, sub })
      });
    } catch (e) {
      status.textContent = "Network error while assigning.";
      return;
    }

    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      // ignore parse error, we'll fall back to HTTP status
    }

    if (!res.ok || !data.ok) {
      status.textContent =
        data.error ||
        ("Failed to assign reserved handle. HTTP " + res.status);
      return;
    }

    status.textContent =
      "Assigned " + data.handle + " to " + data.did + ".";

    if (data.secret_key) {
      secretEl.textContent =
        "New DID record created. Secret key: " + data.secret_key;
    } else {
      secretEl.textContent = "";
    }

    // Refresh UI so registry/policy reflect the change
    loadRegistry();
    loadPolicy();
  }

  async function adminDeleteAllForDid(did) {
    if (!did) return;
    if (!confirm(
      'Delete ALL handles for\\n\\n' +
      did +
      '\\n\\nThis will remove all subdomains for this DID and cannot be undone.'
    )) {
      return;
    }
  
    const res = await fetch("/gg/delete-did", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ did })
    });
  
    if (!res.ok) {
      alert("Failed to delete all handles. HTTP " + res.status);
      return;
    }
  
    // Reload registry & metrics so UI reflects the deletion
    await loadRegistry();
  }
  
  async function loadPolicy() {
    const status = document.getElementById("policy-status");
    status.textContent = "Loading policy…";
    const res = await fetch("/gg/config");
    if (!res.ok) {
      status.textContent = "Failed to load policy. HTTP " + res.status;
      return;
    }
    const cfg = await res.json();
    vipDidsMap = cfg.vipDids || {};
    blockDidsMap = cfg.blockDids || {};
    status.textContent = "Handle limit: " + cfg.maxHandlesPerDid + " (VIPs unlimited).";

    renderPillList("vip-list", cfg.vipDids, removeVipDid);
    renderPillList("block-did-list", cfg.blockDids, removeBlockDid);
    renderPillList("block-pds-list", cfg.blockPds, removeBlockPds);
    renderPillList("blocked-keyword-list", cfg.blockedKeywords || {}, removeBlockedKeyword);
    renderPillList("reserved-list", cfg.reservedHandles, removeReservedHandle);

    if (Array.isArray(registryData) && registryData.length > 0) {
      renderRegistryTable(registryData);
    }
    updateMetrics();
  }

  function renderPillList(id, obj, removeFn) {
    const container = document.getElementById(id);
    container.innerHTML = "";
    Object.keys(obj || {}).forEach(function (key) {
      const pill = document.createElement("span");
      pill.className = "pill";
      const label = document.createElement("span");
      label.textContent = key;
      const btn = document.createElement("button");
      btn.textContent = "✕";
      btn.onclick = function () { removeFn(key); };
      pill.appendChild(label);
      pill.appendChild(btn);
      container.appendChild(pill);
    });
  }

  async function postConfig(payload) {
    const status = document.getElementById("policy-status");
    const res = await fetch("/gg/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      status.textContent = "Policy update failed. HTTP " + res.status;
      return;
    }
    status.textContent = "Policy updated.";
    await loadPolicy();
  }

  async function addVipDid() {
    const input = document.getElementById("vip-input");
    const did = input.value.trim();
    if (!did) return;
    await postConfig({ addVipDid: did });
    input.value = "";
  }
  async function removeVipDid(did) {
    await postConfig({ removeVipDid: did });
  }
  async function addBlockDid() {
    const input = document.getElementById("block-did-input");
    const did = input.value.trim();
    if (!did) return;
    await postConfig({ addBlockDid: did });
    input.value = "";
  }
  async function removeBlockDid(did) {
    await postConfig({ removeBlockDid: did });
  }

  async function addBlockPds() {
    const input = document.getElementById("block-pds-input");
    const host = input.value.trim();
    if (!host) return;
    await postConfig({ addBlockPds: host });
    input.value = "";
  }
  async function removeBlockPds(host) {
    await postConfig({ removeBlockPds: host });
  }

  // 🔹 Supports comma-separated keywords
  async function addBlockedKeyword() {
    const input = document.getElementById("blocked-keyword-input");
    if (!input) return;
  
    const raw = input.value || "";
  
    // split on commas, trim, lowercase, drop empty pieces
    const pieces = raw
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  
    if (!pieces.length) return;
  
    // submit each keyword individually
    for (const kw of pieces) {
      await postConfig({ addBlockedKeyword: kw });
    }
  
    input.value = "";
  }
  
  async function removeBlockedKeyword(kw) {
    await postConfig({ removeBlockedKeyword: kw });
  }
  
  async function addReservedHandle() {
    const input = document.getElementById("reserved-input");
    const sub = (input.value || "").trim().toLowerCase();
    if (!sub) return;
    await postConfig({ addReservedHandle: sub });
    input.value = "";
  }  
  async function removeReservedHandle(sub) {
    await postConfig({ removeReservedHandle: sub });
  }
  
  document.getElementById("vip-add-btn").onclick = addVipDid;
  document.getElementById("block-did-add-btn").onclick = addBlockDid;
  document.getElementById("block-pds-add-btn").onclick = addBlockPds;
  document.getElementById("reserved-add-btn").onclick = addReservedHandle;
  document.getElementById("blocked-keyword-add-btn").onclick = addBlockedKeyword;
  document.getElementById("assign-reserved-btn").onclick = assignReservedHandle;

  const assignBtn = document.getElementById("assign-reserved-btn");
  if (assignBtn) {
    assignBtn.onclick = assignReservedHandle;
  }

  const exportConfigBtn = document.getElementById("export-config-btn");
  const exportRegJsonBtn = document.getElementById("export-registry-json-btn");
  const exportRegCsvBtn = document.getElementById("export-registry-csv-btn");
  const configImportBtn = document.getElementById("config-import-btn");
  const registryImportBtn = document.getElementById("registry-import-btn");

  if (exportConfigBtn) {
    exportConfigBtn.onclick = function () {
      window.location.href = "/gg/export-config";
    };
  }
  if (exportRegJsonBtn) {
    exportRegJsonBtn.onclick = function () {
      window.location.href = "/gg/export-registry?format=json";
    };
  }
  if (exportRegCsvBtn) {
    exportRegCsvBtn.onclick = function () {
      window.location.href = "/gg/export-registry?format=csv";
    };
  }
  if (configImportBtn) {
    configImportBtn.onclick = importConfigFromFile;
  }
  if (registryImportBtn) {
    registryImportBtn.onclick = importRegistryFromFile;
  }

  // --- Enter key wiring helper ---
  function wireEnterKey(inputId, handler) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        handler();
      }
    });
  }

  // VIP / block / reserved fields
  wireEnterKey("vip-input", addVipDid);
  wireEnterKey("block-did-input", addBlockDid);
  wireEnterKey("block-pds-input", addBlockPds);
  wireEnterKey("reserved-input", addReservedHandle);
  wireEnterKey("blocked-keyword-input", addBlockedKeyword);

  // Reserved-assignment fields (either one can submit)
  wireEnterKey("assign-did-input", assignReservedHandle);
  wireEnterKey("assign-sub-input", assignReservedHandle);

  // Handle resolver
  wireEnterKey("resolve-handle-input", resolveHandleToDid);

  // --- Blocked keyword list collapse toggle ---
  (function () {
    const listEl = document.getElementById("blocked-keyword-list");
    const toggleBtn = document.getElementById("blocked-keyword-toggle-btn");
    if (!listEl || !toggleBtn) return;

    let visible = true;

    function updateState() {
      listEl.style.display = visible ? "flex" : "none";
      toggleBtn.textContent = visible ? "Hide list" : "Show list";
    }

    toggleBtn.addEventListener("click", function () {
      visible = !visible;
      updateState();
    });

    // ensure initial state is consistent with CSS
    updateState();
  })();

  async function importConfigFromFile() {
    const status = document.getElementById("backup-status");
    const input = document.getElementById("config-import-file");
    if (!input || !input.files || !input.files[0]) {
      if (status) status.textContent = "Choose a config JSON file first.";
      return;
    }

    const file = input.files[0];
    let text;
    try {
      text = await file.text();
    } catch (e) {
      if (status) status.textContent = "Could not read config file.";
      return;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      if (status) status.textContent = "Config file is not valid JSON.";
      return;
    }

    if (status) status.textContent = "Uploading config…";

    const res = await fetch("/gg/import-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      if (status) status.textContent = "Config import failed. HTTP " + res.status;
      return;
    }

    if (status) status.textContent = "Config imported. Refreshing…";
    await loadPolicy();
  }

  async function importRegistryFromFile() {
    const status = document.getElementById("backup-status");
    const input = document.getElementById("registry-import-file");
    if (!input || !input.files || !input.files[0]) {
      if (status) status.textContent = "Choose a registry JSON file first.";
      return;
    }

    const file = input.files[0];
    let text;
    try {
      text = await file.text();
    } catch (e) {
      if (status) status.textContent = "Could not read registry file.";
      return;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      if (status) status.textContent = "Registry file is not valid JSON.";
      return;
    }

    if (status) status.textContent = "Uploading registry… (this will replace current registry)";

    const res = await fetch("/gg/import-registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      if (status) status.textContent = "Registry import failed. HTTP " + res.status;
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (status) {
      status.textContent =
        "Registry imported (" + (data.imported || "?") + " DIDs). Reloading view…";
    }

    await loadRegistry();
    await loadActivity();
  }

  async function loadActivity() {
    const tbody = document.getElementById("activity-body");
    tbody.innerHTML = "";
    const res = await fetch("/gg/activity");
    if (!res.ok) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "Failed to load activity. HTTP " + res.status;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const data = await res.json();
    (data.events || []).slice().reverse().forEach(function (ev) {
      const tr = document.createElement("tr");
      const timeTd = document.createElement("td");
      timeTd.textContent = ev.ts;
      const typeTd = document.createElement("td");
      typeTd.textContent = ev.type;
      const didTd = document.createElement("td");
      didTd.textContent = ev.did || "";
      const subTd = document.createElement("td");
      subTd.textContent = ev.sub ? ev.sub + ".anarchy.lgbt" : "";
      const pdsTd = document.createElement("td");
      pdsTd.textContent = ev.pdsHost || "";
      tr.appendChild(timeTd);
      tr.appendChild(typeTd);
      tr.appendChild(didTd);
      tr.appendChild(subTd);
      tr.appendChild(pdsTd);
      tbody.appendChild(tr);
    });
  }

  async function loadTrafficMetrics() {
    const regEl = document.getElementById("metric-reg-hour");
    const pdsEl = document.getElementById("metric-top-pds");
    const ipEl  = document.getElementById("metric-ip-spikes");

    if (!regEl || !pdsEl || !ipEl) return;

    regEl.textContent = "…";
    pdsEl.textContent = "…";
    ipEl.textContent  = "…";

    let res;
    try {
      res = await fetch("/gg/metrics");
    } catch (e) {
      regEl.textContent = "error";
      pdsEl.textContent = "error";
      ipEl.textContent  = "error";
      return;
    }

    if (!res.ok) {
      regEl.textContent = "HTTP " + res.status;
      pdsEl.textContent = "HTTP " + res.status;
      ipEl.textContent  = "HTTP " + res.status;
      return;
    }

    const data = await res.json().catch(() => ({}));

    const reg = typeof data.registrationsLastHour === "number"
      ? data.registrationsLastHour
      : 0;
    regEl.textContent = String(reg);

    const topPds = Array.isArray(data.topPds) ? data.topPds : [];
    if (topPds.length === 0) {
      pdsEl.textContent = "none yet";
    } else {
      pdsEl.textContent = topPds
        .map(item => item.host + " (" + item.count + ")")
        .join(", ");
    }

    const ipSpikes = Array.isArray(data.ipSpikes) ? data.ipSpikes : [];
    if (ipSpikes.length === 0) {
      ipEl.textContent = "none notable";
    } else {
      ipEl.textContent = ipSpikes
        .map(item => item.ip + " (" + item.count + ")")
        .join(", ");
    }
  }


  const registryFilterInput = document.getElementById("registry-filter");
  if (registryFilterInput) {
    registryFilterInput.addEventListener("input", function () {
      const q = registryFilterInput.value.trim().toLowerCase();
      if (!q) {
        renderRegistryTable(registryData);
        return;
      }
      const filtered = (registryData || []).filter(function (entry) {
        const did = (entry.did || "").toLowerCase();
        const subs = (entry.handles || []).map(function (h) {
          return (h.sub || "").toLowerCase();
        });
        if (did.indexOf(q) !== -1) return true;
        return subs.some(function (sub) { return sub.indexOf(q) !== -1; });
      });
      renderRegistryTable(filtered);
    });
  }

  async function resolveHandleToDid() {
    const input = document.getElementById("resolve-handle-input");
    const status = document.getElementById("resolve-status");
    const result = document.getElementById("resolve-result");
    const value = (input.value || "").trim();
    if (!value) {
      status.textContent = "Please enter a handle.";
      result.textContent = "";
      return;
    }
    status.textContent = "Resolving…";
    result.textContent = "";
    let res;
    try {
      res = await fetch("/gg/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: value })
      });
    } catch (e) {
      status.textContent = "Network error while resolving.";
      return;
    }
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok || !data.did) {
      status.textContent = data.error || "Could not resolve DID for this handle.";
      result.textContent = "";
      return;
    }
    status.textContent = "Resolved:";
    result.textContent = data.did;
  }

  const resolveBtn = document.getElementById("resolve-handle-btn");
  if (resolveBtn) {
    resolveBtn.onclick = resolveHandleToDid;
  }

  function updateMetrics() {
    const didsEl = document.getElementById("metric-dids");
    const handlesEl = document.getElementById("metric-handles");
    const vipsEl = document.getElementById("metric-vips");
    const blockedEl = document.getElementById("metric-blocked");
    if (!didsEl || !handlesEl || !vipsEl || !blockedEl) return;

    const list = Array.isArray(registryData) ? registryData : [];
    let handleCount = 0;
    list.forEach(function (entry) {
      const arr = Array.isArray(entry.handles) ? entry.handles : [];
      handleCount += arr.length;
    });

    const vipCount = vipDidsMap ? Object.keys(vipDidsMap).length : 0;
    const blockedCount = blockDidsMap ? Object.keys(blockDidsMap).length : 0;

    didsEl.textContent = String(list.length);
    handlesEl.textContent = String(handleCount);
    vipsEl.textContent = String(vipCount);
    blockedEl.textContent = String(blockedCount);
  }

    loadRegistry();
    loadPolicy();
    loadActivity();
    loadTrafficMetrics();
  </script>
</body>
</html>`;

function renderJoinIntroPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Anarchy.LGBT Commune Join</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: radial-gradient(circle at top, #1e293b 0, #020617 55%, #000 100%);
      --panel: rgba(15, 23, 42, 0.6);
      --panel-border: rgba(255, 255, 255, 0.12);
      --panel-radius: 24px;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        sans-serif;
      background: var(--bg);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    .shell {
      position: relative;
      max-width: 960px;
      width: 100%;
      background: var(--panel);
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
      border-radius: var(--panel-radius);
      border: 1px solid var(--panel-border);
      padding: 2.1rem 2.4rem 2.0rem;
      box-shadow:
        0 40px 90px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255, 255, 255, 0.03);
    }

    header h1 {
      margin: 0 0 0.5rem;
      font-size: 2.1rem;
      letter-spacing: 0.02em;
    }

    .subtitle {
      margin: 0;
      font-size: 0.98rem;
      color: var(--text-muted);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin-top: 1.1rem;
      margin-bottom: 1.4rem;
    }

    #theme-sigil {
      position: fixed;
      z-index: 0;
      font-size: 34px;
      font-weight: 700;
      color: #ffffff;
      opacity: 0.35;
      text-shadow:
        0 8px 16px rgba(0, 0, 0, 0.55),
        0 0 14px rgba(15, 23, 42, 0.9);
      pointer-events: none;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.7rem;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.6);
      font-size: 0.8rem;
      color: var(--text-main);
      /*background: rgba(15, 23, 42, 0.35);*/
    }

    .chip-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: radial-gradient(circle at top left, #f97316, #ec4899);
      box-shadow: 0 0 4px rgba(248, 113, 113, 0.8);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1.05fr);
      gap: 2.1rem;
      margin-top: 0.4rem;
    }

    .section-title {
      margin-bottom: 0.4rem;
      font-size: 0.78rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .section p {
      margin: 0.18rem 0;
      font-size: 0.95rem;
      line-height: 1.6;
    }

    .section ul {
      margin: 0.25rem 0 0;
      padding-left: 1.3rem;
      font-size: 0.95rem;
    }

    .section li {
      margin: 0.14rem 0;
    }

    .highlight-box {
      margin-top: 1.2rem;
      padding: 0.9rem 1rem;
      border-radius: 18px;
      border: 1px dashed rgba(148, 163, 184, 0.7);
      background: radial-gradient(circle at top left,
        rgba(56,189,248,0.16),
        rgba(15,23,42,0.95)
      );
      font-size: 0.9rem;
      color: var(--text-main);
    }

    .highlight-box strong {
      font-weight: 600;
    }

    .cta-card {
      background: radial-gradient(circle at top left,
        rgba(239,68,68,0.16),
        rgba(15,23,42,0.96)
      );
      border-radius: 22px;
      border: 1px solid rgba(148,163,184,0.85);
      padding: 1.5rem 1.6rem 1.4rem;
      box-shadow:
        0 22px 50px rgba(15, 23, 42, 0.9),
        0 0 0 1px rgba(15, 23, 42, 0.9);
      font-size: 0.94rem;
    }

    .cta-title {
      font-size: 0.86rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 0.4rem;
    }

    .cta-heading {
      font-size: 1.1rem;
      margin: 0 0 0.6rem;
    }

    .cta-card p {
      margin: 0.25rem 0;
      line-height: 1.55;
    }

    .btn-primary {
      border: none;
      cursor: pointer;
      border-radius: 999px;
      padding: 0.78rem 2.1rem;
      font-size: 0.96rem;
      font-weight: 600;
      margin-top: 1rem;

      background: rgba(60, 90, 120, 0.45);
      color: #e5eaf0;

      box-shadow:
        0 20px 65px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.06);

      transition:
        background-color 0.2s ease,
        box-shadow 0.2s ease,
        transform 0.18s ease,
        filter 0.2s ease;
    }

    .btn-primary:hover {
      background: rgba(90, 150, 255, 0.95);
      color: #000;
      filter: brightness(1.05);
      box-shadow:
        0 26px 80px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255, 255, 255, 0.12);
    }

    .tiny-note {
      margin-top: 0.5rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-top: 2rem;
      padding-top: 0.9rem;
      border-top: 1px solid rgba(30, 64, 175, 0.6);
      font-size: 0.84rem;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .rainbow-link {
      background-image: linear-gradient(
        90deg,
        #f97316,
        #facc15,
        #22c55e,
        #0ea5e9,
        #6366f1,
        #ec4899
      );
      background-clip: text;
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      color: transparent;
    }
    .footer-pill.rainbow-link {
      color: transparent !important;
      -webkit-text-fill-color: transparent;
      background: rgba(15, 23, 42, 0.1);
    }
            
    .footer-right {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      justify-content: flex-end;
      text-weight:strong;
    }

    .footer-pill {
      padding: 0.2rem 0.75rem;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.65);
      background: rgba(15, 23, 42, 0.1);
      font-size: 0.78rem;
      color: var(--text-main);
    }

    a {
      color: #38bdf8;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }

    @media (max-width: 900px) {
      .shell {
        padding: 1.8rem 1.5rem 1.8rem;
      }

      header h1 {
        font-size: 1.8rem;
      }

      .layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 1.6rem;
      }

      .footer {
        flex-direction: column;
        align-items: flex-start;
      }

      .footer-right {
        justify-content: flex-start;
      }
    }

    @media (max-width: 480px) {
      body {
        padding: 1rem;
      }

      .btn-primary {
        width: 100%;
        text-align: center;
      }

      .footer-pill {
        font-size: 0.76rem;
      }
    }
  </style>
</head>
<body>
  <div id="theme-sigil"></div>
  <main class="shell">
    <header>
      <h1>Anarchy.LGBT Commune PDS</h1>
      <p class="subtitle">
        a small, queer, anarchist-run Bluesky PDS &amp; handle space.
      </p>
    </header>

    <div class="chips">
      <div class="chip">
        <span class="chip-dot"></span>
        <span>invite-only</span>
      </div>
      <div class="chip">
        <span>low-population shard</span>
      </div>
      <div class="chip">
        <span>Anarchy.LGBT handles from anarchy.lgbt</code></span>
      </div>
    </div>

    <div class="layout">
      <section class="section">
        <div class="section-title">What this is</div>
        <p>
          anarchy.lgbt is a personal-scale PDS on the AT Protocol. It hosts
          accounts for queer, trans, plural, and adjacent weirdos who want
          to exist a little sideways from the big default servers.
        </p>
        <p>
          There’s no brand strategy, no growth targets, no investors. Just
          one human, some infrastructure, and a lot of feelings about
          autonomy and care.
        </p>

        <div class="section" style="margin-top:1.4rem;">
          <div class="section-title">Who this is for</div>
          <ul>
            <li>you’re queer / trans / otherwise off-axis;</li>
            <li>you’d rather have “quiet &amp; safe” than “infinite reach”;</li>
            <li>you understand this is a finite human’s hobby machine.</li>
          </ul>
        </div>

        <div class="highlight-box">
          <strong>Not a product.</strong>
          This is closer to joining a tiny digital commune than signing up
          for a SaaS. Uptime, capacity, and moderation are all guided by
          “is everyone okay?” instead of “is the chart going up?”.
        </div>
      </section>

      <section class="cta-card">
        <div class="cta-title">How signups work</div>
        <h2 class="cta-heading">Invite-based accounts</h2>
        <p>
          To join, you’ll need an invite code from the admin or from someone
          already on this PDS. The signup flow lives here on
          <code>join.anarchy.lgbt</code> and talks directly to the PDS.
        </p>
        <p>
          Handles are issued under <code>anarchy.lgbt</code>.
        </p>

        <button
          class="btn-primary"
          type="button"
          onclick="window.location.href='/signup'"
        >
          Go to signup
        </button>

        <div class="tiny-note">
          Already have an account on this PDS? You don’t need to do anything here;
          just log in via your Bluesky client using your existing handle.
        </div>
      </section>
    </div>

    <footer class="footer">
     <span class="footer-pill">
      <span class="rainbow-link">
        built as a tiny queer shard of the AT Protocol
      </span>
     </span>
      <div class="footer-right">
        <span class="footer-pill">queer-run infra</span>
        <span class="footer-pill">no VC, no growth deck</span>
      </div>
    </footer>
  </main>

  <script>
    const THEMES_URL = "/themes";

    function clearIntersexRing() {
      const old = document.getElementById("intersex-ring-style");
      if (old) old.remove();
    }

    function applyIntersexRing() {
      clearIntersexRing();

      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<rect width="100" height="100" fill="#f7e11e"/>' +
        '<circle cx="50" cy="50" r="24" fill="none" stroke="#7b2fbf" stroke-width="10" />' +
        "</svg>";

      const encoded = encodeURIComponent(svg);

      const placements = [
        { top: "1.6rem", left: "2.2rem" },
        { top: "1.6rem", right: "2.2rem" },
        { bottom: "2.2rem", left: "2.2rem" },
        { bottom: "2.2rem", right: "2.2rem" }
      ];

      const p = placements[Math.floor(Math.random() * placements.length)];

      const style = document.createElement("style");
      style.id = "intersex-ring-style";

      const pos = Object.entries(p)
        .map(([k, v]) => k + ":" + v + ";")
        .join("");

      style.textContent =
        "body::before{" +
        "content:'';" +
        "position:fixed;" +
        "width:160px;" +
        "height:160px;" +
        "background-image:url(\\"data:image/svg+xml," + encoded + "\\");" +
        "background-repeat:no-repeat;" +
        "background-size:contain;" +
        "opacity:0.82;" +
        "pointer-events:none;" +
        "z-index:0;" +
        pos +
        "}";

      document.head.appendChild(style);
    }

    async function loadThemes() {
      try {
        const res = await fetch(THEMES_URL, { credentials: "omit" });
        if (!res.ok) return;

        const data = await res.json();
        const list = Array.isArray(data) ? data : Object.values(data || {});
        if (!list.length) return;

        const theme = list[Math.floor(Math.random() * list.length)];

        if (theme.background) {
          document.body.style.background = theme.background;
        }

        const sigilEl = document.getElementById("theme-sigil");
        if (!sigilEl) return;

        sigilEl.textContent = "";
        clearIntersexRing();

        sigilEl.style.position = "fixed";
        sigilEl.style.zIndex = "0";
        sigilEl.style.pointerEvents = "none";
        sigilEl.style.textShadow =
          "0 8px 16px rgba(0,0,0,0.55), 0 0 14px rgba(15,23,42,0.9)";

        const id = (
          theme.id ||
          theme.key ||
          theme.slug ||
          theme.name ||
          ""
        ).toLowerCase();

        const isIntersex = /intersex/i.test(id);
        if (isIntersex) {
                  sigilEl.textContent = "";
          applyIntersexRing();
          return;
        }

        if (theme.sigil) {
          sigilEl.textContent = theme.sigil;
        }

        // lesbian → bottom-right, orange-pink
        if (id.includes("lesbian")) {
          sigilEl.style.color = "#fb7185";
          sigilEl.style.fontSize = "36px";
          sigilEl.style.fontWeight = "800";
          sigilEl.style.bottom = "2rem";
          sigilEl.style.right = "2rem";
          sigilEl.style.top = "auto";
          sigilEl.style.left = "auto";
          sigilEl.style.opacity = "0.9";
          return;
        }

        // gay → top-left, blue
        if (id.includes("gay")) {
          sigilEl.style.color = "#3b82f6";
          sigilEl.style.fontSize = "30px";
          sigilEl.style.fontWeight = "700";
          sigilEl.style.top = "2rem";
          sigilEl.style.left = "2rem";
          sigilEl.style.right = "auto";
          sigilEl.style.bottom = "auto";
          sigilEl.style.opacity = "0.9";
          return;
        }

        // autism → top-right, yellow
        if (id.includes("autism")) {
          sigilEl.style.color = "#ffdd00";
          sigilEl.style.fontSize = "38px";
          sigilEl.style.fontWeight = "800";
          sigilEl.style.top = "2rem";
          sigilEl.style.right = "2rem";
          sigilEl.style.left = "auto";
          sigilEl.style.bottom = "auto";
          sigilEl.style.opacity = "0.9";
          return;
        }

        // default: bottom-right, white-ish
        sigilEl.style.color = theme.sigilColor || "#ffffff";
        sigilEl.style.fontSize = "34px";
        sigilEl.style.fontWeight = "700";
        sigilEl.style.bottom = "2rem";
        sigilEl.style.right = "2rem";
        sigilEl.style.top = "auto";
        sigilEl.style.left = "auto";
        sigilEl.style.opacity = "0.35";
      } catch (err) {
        console.error(err);
      }
    }

    document.addEventListener("DOMContentLoaded", function () {
      loadThemes();
    });
  </script>
</body>
</html>`;
}

function renderJoinSignupPage(domainsCsv = "") {
  // Turn "anarchy.lgbt,pds.anarchy.lgbt" into ["anarchy.lgbt","pds.anarchy.lgbt"]
  const domains = (domainsCsv || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const fallbackDomains = domains.length ? domains : ["anarchy.lgbt"];

  const domainsJson = JSON.stringify(fallbackDomains);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Anarchy.LGBT Signup</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      --bg: radial-gradient(circle at top, #1e293b 0, #020617 55%, #000 100%);
      --panel: rgba(15, 23, 42, 0.96);
      --panel-border: rgba(148, 163, 184, 0.65);
      --panel-radius: 28px;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.12);
      --chip-bg: rgba(15, 23, 42, 0);
      --cta-gradient: linear-gradient(135deg, #22c1c3, #4f46e5);
      --cta2-gradient: linear-gradient(135deg, #f97316, #ec4899);
      --input-bg: rgba(15, 23, 42, 0.92);
      --input-border: rgba(148, 163, 184, 0.75);
      --error: #fecaca;
      --success: #bbf7d0;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        sans-serif;
      background: var(--bg);
      color: var(--text-main);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      position: relative;
    }

    .shell {
      position: relative;
      z-index: 1;
      max-width: 960px;
      width: 100%;
    
      /* transparency from /a */
      background: rgba(15, 23, 42, 0.6);
      -webkit-backdrop-filter: blur(12px);
    
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.12);
    
      padding: 2rem 2.4rem 1.9rem;
    
      box-shadow:
        0 40px 90px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255, 255, 255, 0.03);
    }

    
    header h1 {
      margin: 0 0 0.4rem;
      font-size: 2rem;
      letter-spacing: 0.02em;
    }

    .subtitle {
      margin: 0;
      font-size: 0.98rem;
      color: var(--text-muted);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin-top: 1rem;
      margin-bottom: 1.2rem;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.25rem 0.7rem;
      border-radius: 999px;
      background: var(--chip-bg);
      border: 1px solid rgba(148, 163, 184, 0.6);
      font-size: 0.8rem;
      color: var(--text-main);
    }

    .chip-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: radial-gradient(circle at top left, #22c55e, #16a34a);
      box-shadow: 0 0 4px rgba(34, 197, 94, 0.7);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.1fr);
      gap: 2rem;
      margin-top: 0.5rem;
    }

    .section {
      margin-top: 1.2rem;
      font-size: 0.96rem;
      line-height: 1.6;
    }

    .section-title {
      margin-bottom: 0.35rem;
      font-size: 0.8rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .section p {
      margin: 0.15rem 0 0;
    }

    .section ul {
      margin: 0.2rem 0 0;
      padding-left: 1.3rem;
    }

    .section li {
      margin: 0.14rem 0;
    }

    .signup-card {
      background: radial-gradient(circle at top left, rgba(56,189,248,0.16), rgba(15,23,42,0.95));
      border-radius: 22px;
      border: 1px solid rgba(148,163,184,0.8);
      padding: 1.5rem 1.6rem 1.4rem;
      box-shadow:
        0 22px 50px rgba(15, 23, 42, 0.9),
        0 0 0 1px rgba(15, 23, 42, 0.9);
    }

    .signup-title {
      font-size: 0.9rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 0.4rem;
    }

    .signup-heading {
      font-size: 1.15rem;
      margin: 0 0 0.8rem;
    }

    .field {
      margin-top: 0.7rem;
      font-size: 0.9rem;
    }

    .field-label-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .field label {
      font-size: 0.82rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }

    .field-hint {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .input,
    .select {
      width: 100%;
      padding: 0.55rem 0.75rem;
      border-radius: 12px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--text-main);
      font-size: 0.9rem;
    }

    .input:focus,
    .select:focus {
      outline: 1px solid #38bdf8;
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.4);
    }

    .handle-row {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.3fr);
      gap: 0.6rem;
    }

    .handle-preview {
      margin-top: 0.35rem;
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .handle-preview code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      padding: 0.12rem 0.45rem;
      border-radius: 999px;
      background: rgba(15,23,42,0.9);
      border: 1px solid rgba(148,163,184,0.6);
      color: #e5e7eb;
    }

    .cta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.7rem;
      margin-top: 1.2rem;
      align-items: center;
    }

    .btn-primary {
      border: none;
      cursor: pointer;
      border-radius: 999px;
      padding: 0.75rem 1.9rem;
      font-size: 0.95rem;
      font-weight: 600;
      white-space: nowrap;
    
      background: rgba(60, 90, 120, 0.45);   /* muted matte blue */
      color: #e5eaf0;
    
      /* The apex soft glow */
      box-shadow:
        0 20px 65px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(255, 255, 255, 0.06);
    
      transition:
        background-color 0.2s ease,
        box-shadow 0.2s ease,
        transform 0.18s ease,
        filter 0.2s ease;
    }
    
    .btn-primary[disabled] {
      opacity: 0.75;
      cursor: default;
    }
    .btn-primary:hover:not([disabled]) {
      background: rgba(90, 150, 255, 0.95);  /* apex bright hover blue */
      color: #000000;
      filter: brightness(1.05);
    
      box-shadow:
        0 26px 80px rgba(0, 0, 0, 0.65),
        0 0 0 1px rgba(255, 255, 255, 0.12);
    }
    
    .status {
      font-size: 0.82rem;
      margin-top: 0.5rem;
      min-height: 1.1em;
    }

    .status.error {
      color: var(--error);
    }

    .status.success {
      color: var(--success);
    }

    .status-muted {
      color: var(--text-muted);
    }

    .tiny-note {
      margin-top: 0.4rem;
      font-size: 0.78rem;
      color: var(--text-muted);
    }

    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-top: 2.1rem;
      padding-top: 0.9rem;
      border-top: 1px solid rgba(30, 64, 175, 0.6);
      font-size: 0.85rem;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .footer-left {
      cursor: pointer;
      font-size: 0.86rem;
      font-weight: 500;
    }

    .rainbow-link {
      background-image: linear-gradient(
        90deg,
        #f97316,
        #facc15,
        #22c55e,
        #0ea5e9,
        #6366f1,
        #ec4899
      );
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
    }

    .footer-right-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      justify-content: flex-end;
    }

    .footer-pill {
      padding: 0.2rem 0.75rem;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.65);
      background: rgba(15, 23, 42, 0.1);
      font-size: 0.78rem;
      color: var(--text-main);
    }

    a {
      color: #38bdf8;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    #theme-sigil {
      position: fixed;
      z-index: 0;
      font-size: 34px;
      font-weight: 700;
      color: #ffffff;
      opacity: 0.35;
      text-shadow:
        0 8px 16px rgba(0, 0, 0, 0.55),
        0 0 14px rgba(15, 23, 42, 0.9);
      pointer-events: none;
    }

    @media (max-width: 900px) {
      .shell {
        padding: 1.6rem 1.4rem 1.7rem;
        border-radius: 22px;
      }

      header h1 {
        font-size: 1.7rem;
      }

      .layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 1.4rem;
      }

      .footer {
        flex-direction: column;
        align-items: flex-start;
      }

      .footer-right-pills {
        justify-content: flex-start;
      }
    }

    @media (max-width: 480px) {
      body {
        padding: 1rem;
      }

      .cta-row {
        flex-direction: column;
        align-items: stretch;
      }

      .btn-primary {
        width: 100%;
        text-align: center;
      }

      .footer-pill {
        font-size: 0.76rem;
      }
    }
  </style>
</head>
<body>
  <div id="theme-sigil"></div>

  <main class="shell">
    <header>
      <h1>Apply for an account on the Anarchy.LGBT PDS</h1>
      <p class="subtitle">
        Small, queer, anarchist-run Bluesky PDS. No growth targets, no brand, no VC.
      </p>
    </header>

    <div class="chips">
      <div class="chip">
        <span class="chip-dot"></span>
        <span>invite-only</span>
      </div>
      <div class="chip">
        <span>AT Protocol</span>
      </div>
      <div class="chip">
        <span>Anarchy.LGBT handles from anarchy.lgbt</span>
      </div>
    </div>

    <div class="layout">
      <section class="section">
        <div class="section-title">What this is</div>
        <p>
          anarchy.lgbt is a personal-scale PDS: a small server in the Bluesky network
          for queer, trans, plural, and adjacent weirdos who want to exist outside the big,
          bland defaults. It’s tuned more for vibes and safety than for raw user count.
        </p>

        <div class="section" style="margin-top:1.4rem;">
          <div class="section-title">Who it’s for</div>
          <p>Roughly speaking:</p>
          <ul>
            <li>you’re queer/trans and like decentralization more than brand accounts;</li>
            <li>you’re okay with “slow and careful” instead of “infinite growth”;</li>
            <li>
              you understand that this is a personal machine with finite time, energy, and spoons.
            </li>
          </ul>
        </div>

        <div class="section" style="margin-top:1.4rem;">
          <div class="section-title">Invites</div>
          <p>
            You’ll usually get an invite directly from the human running this box,
            or from someone already here. This keeps the graph dense and the fascists bored.
          </p>
        </div>
      </section>

      <section class="signup-card">
        <div class="signup-title">Signup</div>
        <h2 class="signup-heading">Anarchy.LGBT signup</h2>

        <form id="signup-form" novalidate>
          <div class="field">
            <div class="field-label-row">
              <label for="email">Email</label>
              <span class="field-hint">For login + recovery (not for spam).</span>
            </div>
            <input
              id="email"
              name="email"
              type="email"
              class="input"
              autocomplete="email"
              required
            />
          </div>

            <div class="field">
            <div class="field-label-row">
              <label for="handle-local">Handle</label>
              <span class="field-hint">Pick something comfy. (4–40 characters).</span>
            </div>
            <div class="handle-row">
              <input
                id="handle-local"
                name="handleLocal"
                type="text"
                class="input"
                placeholder="riotgrrrl"
                autocomplete="username"
                pattern="^[a-z0-9][a-z0-9\-]{3,39}$"
                title="Use 4–40 characters. Allowed: a–z, 0–9, -"
                required
              />
              <select id="handle-domain" name="handleDomain" class="select"></select>
            </div>
            <div class="handle-preview">
              your Bluesky handle will be:
              <code id="handle-preview-code">riotgrrrl.${fallbackDomains[0]}</code>
            </div>
          </div>
        
          <div class="field">
            <div class="field-label-row">
              <label for="password">Password</label>
              <span class="field-hint">Stored on the PDS, not on Bluesky HQ.</span>
            </div>
            <input
              id="password"
              name="password"
              type="password"
              class="input"
              autocomplete="new-password"
              required
            />
          </div>

          <div class="field">
            <div class="field-label-row">
              <label for="password-confirm">Confirm password</label>
              <span class="field-hint">Must match.</span>
            </div>
            <input
              id="password-confirm"
              name="passwordConfirm"
              type="password"
              class="input"
              autocomplete="new-password"
              required
            />
          </div>

          <div class="field">
            <div class="field-label-row">
              <label for="invite-code">Invite code</label>
              <span class="field-hint">Provided by a member</span>
            </div>
            <input
              id="invite-code"
              name="inviteCode"
              type="text"
              class="input"
              autocomplete="off"
              required
            />
          </div>

          <div class="cta-row">
            <button class="btn-primary" type="submit" id="submit-btn">
              Apply
            </button>
          </div>
          <div class="status status-muted" id="status-line">
            This calls the standard Bluesky <code>com.atproto.server.createAccount</code> endpoint via this PDS.
          </div>
        
          <div class="tiny-note">
            This PDS is small on purpose.
          </div>
        </form>
      </section>
    </div>

    <footer class="footer">
      <span
        class="footer-left rainbow-link"
        onclick="window.location.href='https://anarchy.lgbt/a'"
      >
        ?
      </span>

      <div class="footer-right-pills">
        <span class="footer-pill">low-population shard</span>
        <span class="footer-pill">queer-run infrastructure</span>
      </div>
    </footer>
  </main>

  <script>
    const THEMES_URL = "/themes";
    const PDS_ENDPOINT = "/signup/xrpc/com.atproto.server.createAccount";
    const DOMAIN_OPTIONS = ${domainsJson};

    function clearIntersexRing() {
      const old = document.getElementById("intersex-ring-style");
      if (old) old.remove();
    }

    function applyIntersexRing() {
      clearIntersexRing();

      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
        '<rect width="100" height="100" fill="#f7e11e"/>' +
        '<circle cx="50" cy="50" r="24" fill="none" stroke="#7b2fbf" stroke-width="10" />' +
        "</svg>";

      const encoded = encodeURIComponent(svg);

      const placements = [
        { top: "1.6rem", left: "2.2rem" },
        { top: "1.6rem", right: "2.2rem" },
        { bottom: "2.2rem", left: "2.2rem" },
        { bottom: "2.2rem", right: "2.2rem" }
      ];

      const p = placements[Math.floor(Math.random() * placements.length)];

      const style = document.createElement("style");
      style.id = "intersex-ring-style";
      style.textContent =
        \`
body::before {
  content: "";
  position: fixed;
  width: 160px;
  height: 160px;
  background-image: url("data:image/svg+xml,\` +
        encoded +
        \`");
  background-repeat: no-repeat;
  background-size: contain;
  opacity: 0.82;
  pointer-events: none;
  z-index: 0;
  \` +
        Object.entries(p)
          .map(([k, v]) => \`\${k}:\${v};\`)
          .join("") +
        \`
}
\`;
      document.head.appendChild(style);
    }

    async function loadThemes() {
      try {
        const res = await fetch(THEMES_URL, { credentials: "omit" });
        if (!res.ok) return;

        const data = await res.json();
        const list = Array.isArray(data) ? data : Object.values(data || {});
        if (!list.length) return;

        const theme = list[Math.floor(Math.random() * list.length)];

        if (theme.background) {
          document.body.style.background = theme.background;
        }

        const sigilEl = document.getElementById("theme-sigil");
        if (!sigilEl) return;

        sigilEl.textContent = "";
        clearIntersexRing();

        sigilEl.style.position = "fixed";
        sigilEl.style.zIndex = "0";
        sigilEl.style.pointerEvents = "none";
        sigilEl.style.textShadow =
          "0 8px 16px rgba(0,0,0,0.55), 0 0 14px rgba(15,23,42,0.9)";

        const id =
          (theme.id ||
            theme.key ||
            theme.slug ||
            theme.name ||
            "")
            .toLowerCase();

            const isIntersex = /intersex/i.test(id);
            if (isIntersex) {
                      sigilEl.textContent = "";
          applyIntersexRing();
          return;
        }

        if (theme.sigil) {
          sigilEl.textContent = theme.sigil;
        }

        if (id.includes("lesbian")) {
          sigilEl.style.color = "#fb7185";
          sigilEl.style.fontSize = "36px";
          sigilEl.style.fontWeight = "800";
          sigilEl.style.bottom = "2rem";
          sigilEl.style.opacity = "0.9";
          sigilEl.style.right = "2rem";
          sigilEl.style.top = "auto";
          sigilEl.style.left = "auto";
          return;
        }

        if (id.includes("gay")) {
          sigilEl.style.color = "#3b82f6";
          sigilEl.style.fontSize = "30px";
          sigilEl.style.fontWeight = "700";
          sigilEl.style.top = "2rem";
          sigilEl.style.left = "2rem";
          sigilEl.style.right = "auto";
          sigilEl.style.bottom = "auto";
          sigilEl.style.opacity = "0.9";
          return;
        }

        if (id.includes("autism")) {
          sigilEl.style.color = "#ffdd00";
          sigilEl.style.fontSize = "38px";
          sigilEl.style.fontWeight = "800";
          sigilEl.style.top = "2rem";
          sigilEl.style.right = "2rem";
          sigilEl.style.left = "auto";
          sigilEl.style.bottom = "auto";
          sigilEl.style.opacity = "0.9";
          return;
        }

        sigilEl.style.color = theme.sigilColor || "#ffffff";
        sigilEl.style.fontSize = "34px";
        sigilEl.style.fontWeight = "700";
        sigilEl.style.bottom = "2rem";
        sigilEl.style.right = "2rem";
        sigilEl.style.top = "auto";
        sigilEl.style.left = "auto";
      } catch (err) {
        console.error(err);
      }
    }

    function initDomains() {
      const select = document.getElementById("handle-domain");
      const preview = document.getElementById("handle-preview-code");
      const local = document.getElementById("handle-local");
      if (!select || !preview || !local) return;

      select.innerHTML = "";
      DOMAIN_OPTIONS.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        select.appendChild(opt);
      });

      function updatePreview() {
        const l = (local.value || "").trim() || "riotgrrrl";
        const d = select.value || DOMAIN_OPTIONS[0] || "anarchy.lgbt";
        preview.textContent = l + "." + d;
      }

      local.addEventListener("input", updatePreview);
      select.addEventListener("change", updatePreview);
      updatePreview();
    }

    function initSignupForm() {
      const form = document.getElementById("signup-form");
      const status = document.getElementById("status-line");
      const submitBtn = document.getElementById("submit-btn");
      if (!form || !status || !submitBtn) return;

      form.addEventListener("submit", async function (e) {
        e.preventDefault();

        const email = document.getElementById("email").value.trim();
        const handleLocal = document.getElementById("handle-local").value.trim();
        const handleDomain = document.getElementById("handle-domain").value;
        const password = document.getElementById("password").value;
        const passwordConfirm = document.getElementById("password-confirm").value;
        const inviteCode = document.getElementById("invite-code").value.trim();

        status.className = "status";
        status.textContent = "";

        if (!email || !handleLocal || !handleDomain || !password || !passwordConfirm || !inviteCode) {
          status.classList.add("error");
          status.textContent = "Fill in all fields before submitting.";
          return;
        }
        
        // Enforce 4–40 chars for the local part, matching the HTML pattern
        if (handleLocal.length < 4 || handleLocal.length > 40) {
          status.classList.add("error");
          status.textContent = "Handle must be between 4 and 40 characters long.";
          return;
        }
        
        if (password !== passwordConfirm) {
          status.classList.add("error");
          status.textContent = "Passwords do not match.";
          return;
        }
        
        const handle = handleLocal + "." + handleDomain;
        
        submitBtn.disabled = true;
        status.className = "status status-muted";
        status.textContent = "Sending account request to the PDS…";

        try {
          const res = await fetch(PDS_ENDPOINT, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              email,
              handle,
              password,
              inviteCode
            })
          });

          const data = await res.json().catch(() => ({}));

          if (!res.ok) {
            status.className = "status error";
            const msg =
              (data && (data.message || data.error || data.errorMessage)) ||
              ("Signup failed (HTTP " + res.status + ").");
            status.textContent = msg;
          } else {
            status.className = "status success";
            status.textContent =
              "Account created (or queued) for " + handle + ". You can now log in on Bluesky and/or this PDS.";
              form.reset();

              // Reset handle preview to default
              const local = document.getElementById("handle-local");
              const select = document.getElementById("handle-domain");
              const preview = document.getElementById("handle-preview-code");
              
              if (local && select && preview) {
                const d = select.value || DOMAIN_OPTIONS[0] || "anarchy.lgbt";
                preview.textContent = "riotgrrrl." + d;
              }
                        }
        } catch (err) {
          console.error(err);
          status.className = "status error";
          status.textContent =
            "Network or server error while talking to the PDS. Try again in a bit.";
        } finally {
          submitBtn.disabled = false;
        }
      });
    }

    document.addEventListener("DOMContentLoaded", function () {
      loadThemes();
      initDomains();
      initSignupForm();
    });
  </script>
</body>
</html>`;
}


// ---------------------------------------------------------
// Public handlers
// ---------------------------------------------------------

async function handleRegister(env, request) {
  const body = await parseJson(request);
  const rawHandle = body.handle;
  const rawSub = body.subdomain;

  const handle = normalizeHandle(rawHandle);
  const sub = normalizeSubdomain(rawSub);

  if (!handle) {
    return jsonResponse(
      { error: "You need to provide your current Bluesky handle." },
      { status: 400 }
    );
  }
  if (!sub) {
    return jsonResponse(
      { error: "You need to choose a valid handle under " + BASE_DOMAIN + "." },
      { status: 400 }
    );
  }

  // Figure out caller "tier"
  const clientIp = getClientIp(request);
  const trusted = isTrustedIp(env, request);
  const admin = isAdmin(request);
  const bypassLimits = trusted || admin;

  // Load block config once (for keywords, DID blocks, PDS blocks)
  const blockCfg = await loadBlockConfig(env);

  // -----------------------------------
  // Blocked handle keywords (slurs etc.)
  // -----------------------------------
  if (blockCfg.blockedKeywords) {
    const loweredSub = sub.toLowerCase();
    for (const kw of Object.keys(blockCfg.blockedKeywords)) {
      const keyword = (kw || "").toLowerCase().trim();
      if (!keyword) continue;
      if (loweredSub.includes(keyword)) {
        return jsonResponse(
          {
            error:
              "This handle contains a restricted word and cannot be registered."
          },
          { status: 400 }
        );
      }
    }
  }

  // Reserved handles
  const reservedCfg = await loadReservedConfig(env);
  if (reservedCfg.reservedHandles && reservedCfg.reservedHandles[sub]) {
    return jsonResponse(
      {
        error: "This handle is reserved and cannot be registered."
      },
      { status: 403 }
    );
  }

  const did = await resolveDidFromHandle(handle);
  if (!did) {
    return jsonResponse(
      { error: "Could not resolve DID for this handle." },
      { status: 400 }
    );
  }

  // Direct DID block
  if (blockCfg.blockDids && blockCfg.blockDids[did]) {
    await logActivity(env, {
      ts: new Date().toISOString(),
      type: "register_blocked_did",
      did,
      sub: null,
      pdsHost: null
    });

    return jsonResponse(
      { error: "This DID is blocked from registering handles." },
      { status: 403 }
    );
  }

  // Derive PDS host from PLC doc and apply PDS-level block, if any.
  const pdsHost = await resolvePdsHostForDid(did);
  if (pdsHost && blockCfg.blockPds && blockCfg.blockPds[pdsHost]) {
    await logActivity(env, {
      ts: new Date().toISOString(),
      type: "register_blocked_pds",
      did,
      sub: null,
      pdsHost
    });

    return jsonResponse(
      {
        error:
          "Registrations from this PDS host are blocked (" +
          pdsHost +
          ")."
      },
      { status: 403 }
    );
  }

  // -----------------------------------
  // Rate limits (VIP + trust aware)
  // -----------------------------------

  // Load VIP config once; reused for handle-count check later
  const vipCfg = await loadVipConfig(env);
  const isVip = !!(vipCfg.vipDids && vipCfg.vipDids[did]);

  // Burst + hourly per-IP (for /register only)
  if (!bypassLimits && clientIp) {
    // Burst: e.g. 10 registration attempts per 60 seconds
    const overBurst = await incrementGuard(
      env,
      `${RATE_IP_PREFIX}${clientIp}:register:burst:`,
      BURST_IP_WINDOW_SECONDS,
      BURST_IP_MAX_OPS
    );
    if (overBurst) {
      return jsonResponse(
        {
          error:
            "This connection is sending handle requests very quickly. Slow down and try again in a while."
        },
        { status: 429 }
      );
    }

    // Hourly: non-admin, non-trusted IPs get a softer ceiling
    const hourlyLimit = 50; // registrations/hour/IP (tweakable)
    const overIpHour = await incrementGuard(
      env,
      `${RATE_IP_PREFIX}${clientIp}:register:hour:`,
      3600,
      hourlyLimit
    );
    if (overIpHour) {
      return jsonResponse(
        {
          error:
            "Way too many handle requests from this connection in a short period. Take a breather and again a bit later."
        },
        { status: 429 }
      );
    }
  }

  // Per-DID hourly limit (higher for VIPs)
  if (!bypassLimits) {
    const perDidLimit = isVip ? 60 : 10; // VIPs get a much higher ceiling
    const overDid = await incrementGuard(
      env,
      `${RATE_DID_PREFIX}${did}:hour:`,
      3600,
      perDidLimit
    );
    if (overDid) {
      return jsonResponse(
        {
          error:
            "This DID has made a lot of handle requests recently. Take a break and try again later."
        },
        { status: 429 }
      );
    }
  }

  // Per-PDS hourly limit (cluster of accounts on same server)
  if (!bypassLimits && pdsHost) {
    const overPds = await incrementGuard(
      env,
      `${RATE_PDS_PREFIX}${pdsHost}:hour:`,
      3600,
      100
    );
    if (overPds) {
      return jsonResponse(
        {
          error:
            "Accounts from your PDS have sent a lot of handle requests recently. Try again later, or use a different PDS if that option is available for you."
        },
        { status: 429 }
      );
    }
  }

  // -----------------------------------
  // Handle ownership + VIP handle-count limits
  // -----------------------------------
  const subKey = SUB_PREFIX + sub;
  const existingSub = await env.anarchydids.get(subKey);
  if (existingSub) {
    return jsonResponse(
      {
        error:
          'This handle is already registered under ' +
          BASE_DOMAIN +
          '. To make changes or delete a handle, use the <a href="/m" style="color:#38bdf8;text-decoration:underline;">Manage / Change handles</a> link below.'
      },
      { status: 409 }
    );
  }

  const didKey = DID_PREFIX + did;
  let didRecord = await env.anarchydids.get(didKey, "json");
  const now = new Date().toISOString();

  let secretKey = null;

  if (!didRecord) {
    // First time we see this DID in this registry → generate secret
    secretKey = generateSecretKey();
    const keyHash = await hashString(secretKey);
    didRecord = {
      keyHash,
      createdAt: now,
      handles: [{ sub, createdAt: now }]
    };
  } else {
    if (!Array.isArray(didRecord.handles)) didRecord.handles = [];

    if (!isVip) {
      const count = didRecord.handles.length;
      if (count >= MAX_HANDLES_PER_DID) {
        return jsonResponse(
          {
            error:
              "Handle limit reached (" +
              MAX_HANDLES_PER_DID +
              "). Contact admin for VIP access."
          },
          { status: 400 }
        );
      }
    }

    const already = didRecord.handles.some(h => h.sub === sub);
    if (!already) {
      didRecord.handles.unshift({ sub, createdAt: now });
    }
  }

  await env.anarchydids.put(didKey, JSON.stringify(didRecord));
  await env.anarchydids.put(
    subKey,
    JSON.stringify({ did, createdAt: now })
  );

  await logActivity(env, {
    ts: now,
    type: "register",
    did,
    sub,
    pdsHost: pdsHost || null
  });

  return jsonResponse({
    ok: true,
    did,
    handle: sub + "." + BASE_DOMAIN,
    secret_key: secretKey
  });
}

// Model B1: public deletion by secret + handle/sub. No VIP/block checks.
async function handleDelete(env, request) {
  // Soft per-IP rate limit for delete operations
  try {
    const ip = getClientIp(request) || "unknown";
    const trusted = isTrustedIp(env, request);
    const admin = isAdmin(request);
  
    if (ip !== "unknown" && !trusted && !admin) {
      const over = await incrementGuard(env, `ops:${ip}:`, 3600, 100);
      if (over) {
        return jsonResponse(
          {
            error:
              "Handle deletion has seen a lot of activity from this connection. Take a breather and try again later."
          },
          { status: 429 }
        );
      }
    }
  } catch {
    // If limiter explodes, don’t block deletes entirely.
  }

  const body = await parseJson(request);
  const secret = body.secret_key || body.secret;
  let sub = body.sub || body.subdomain || null;
  const handle = body.handle;

  if (!secret) {
    return jsonResponse(
      { error: "You must provide your secret key." },
      { status: 400 }
    );
  }

  if (!sub && handle) {
    const norm = normalizeHandle(handle);
    if (!norm || !norm.endsWith("." + BASE_DOMAIN)) {
      return jsonResponse(
        { error: "Provide a valid handle under " + BASE_DOMAIN + "." },
        { status: 400 }
      );
    }
    sub = norm.slice(0, norm.length - ("." + BASE_DOMAIN).length);
  }

  sub = normalizeSubdomain(sub);
  if (!sub) {
    return jsonResponse(
      { error: "You must specify which handle to delete." },
      { status: 400 }
    );
  }

  const secretHash = await hashString(secret);
  const found = await findDidBySecretHash(env, secretHash);
  if (!found) {
    return jsonResponse(
      { error: "No DID is associated with that secret key." },
      { status: 404 }
    );
  }

  const { did, record } = found;
  const didKey = DID_PREFIX + did;
  const subKey = SUB_PREFIX + sub;

  const owns = (record.handles || []).some(h => h.sub === sub);
  if (!owns) {
    return jsonResponse(
      { error: "This secret does not control that handle." },
      { status: 400 }
    );
  }

  record.handles = (record.handles || []).filter(h => h.sub !== sub);

  if (record.handles.length === 0) {
    await env.anarchydids.delete(didKey);
  } else {
    await env.anarchydids.put(didKey, JSON.stringify(record));
  }
  await env.anarchydids.delete(subKey);

  await logActivity(env, {
    ts: new Date().toISOString(),
    type: "delete",
    did,
    sub,
    pdsHost: null
  });

  return jsonResponse({ ok: true, deleted: true });
}

// /m API: secret-only list + delete
async function handleManage(env, request) {
  // Soft per-IP rate limit for manage operations (list/delete via secret key)
  try {
    const ip = getClientIp(request) || "unknown";
    const trusted = isTrustedIp(env, request);
    const admin = isAdmin(request);
  
    if (ip !== "unknown" && !trusted && !admin) {
      const over = await incrementGuard(env, `ops:${ip}:`, 3600, 100);
      if (over) {
        return jsonResponse(
          {
            error:
              "Handle deletion has seen a lot of activity from this connection. Take a breather and try again later."
          },
          { status: 429 }
        );
      }
    }
  } catch {
    // If rate limiter fails, don’t hard-break manage; just skip limiting.
  }

  const body = await parseJson(request);
  const action = body.action || "list";
  const secret = body.secret;

  if (!secret) {
    return jsonResponse(
      { error: "You must provide your secret key." },
      { status: 400 }
    );
  }

  const secretHash = await hashString(secret);
  const found = await findDidBySecretHash(env, secretHash);
  if (!found) {
    return jsonResponse(
      { error: "No handles found for that secret key." },
      { status: 404 }
    );
  }

  const { did, record } = found;
  const didKey = DID_PREFIX + did;

  if (action === "list") {
    const handles = (record.handles || []).map(h => ({
      sub: h.sub,
      full: h.sub + "." + BASE_DOMAIN,
      created_at: h.createdAt
    }));
    return jsonResponse({ ok: true, did, handles });
  }

  if (action === "delete") {
    let sub = body.sub || body.subdomain || null;
    const handle = body.handle;
    if (!sub && handle) {
      const norm = normalizeHandle(handle);
      if (norm && norm.endsWith("." + BASE_DOMAIN)) {
        sub = norm.slice(0, norm.length - ("." + BASE_DOMAIN).length);
      }
    }
    sub = normalizeSubdomain(sub);
    if (!sub) {
      return jsonResponse(
        { error: "You must specify which handle to delete." },
        { status: 400 }
      );
    }

    const owns = (record.handles || []).some(h => h.sub === sub);
    if (!owns) {
      return jsonResponse(
        { error: "This secret does not control that handle." },
        { status: 400 }
      );
    }

    record.handles = (record.handles || []).filter(h => h.sub !== sub);

    const subKey = SUB_PREFIX + sub;
    await env.anarchydids.delete(subKey);

    if (!record.handles.length) {
      await env.anarchydids.delete(didKey);
    } else {
      await env.anarchydids.put(didKey, JSON.stringify(record));
    }

    await logActivity(env, {
      ts: new Date().toISOString(),
      type: "delete",
      did,
      sub,
      pdsHost: null
    });

    return jsonResponse({ ok: true, did, deleted: sub + "." + BASE_DOMAIN });
  }

  return jsonResponse({ error: "Unknown manage action." }, { status: 400 });
}

async function handleWellKnown(env, request) {
  const url = new URL(request.url);
  const host = url.hostname;

  if (!host.endsWith("." + BASE_DOMAIN)) {
    return new Response("not found", { status: 404 });
  }

  const suffix = "." + BASE_DOMAIN;
  const sub = host.slice(0, host.length - suffix.length);
  const recRaw = await env.anarchydids.get(SUB_PREFIX + sub);
  if (!recRaw) return new Response("not found", { status: 404 });

  let rec;
  try {
    rec = JSON.parse(recRaw);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!rec.did) return new Response("not found", { status: 404 });

  return new Response(rec.did, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

// ---------------------------------------------------------
// Admin helpers & handlers
// ---------------------------------------------------------

function isAdmin(request /*, env */) {
  const cookies = parseCookies(request);
  return cookies.anarchy_admin === "1";
}

async function handleAdminGet(env, request) {
  if (!isAdmin(request)) {
    const theme = pickPrideTheme();
    const html = renderAdminLoginPage({ theme, errorHtml: "" });
    return htmlResponse(html);
  }
  return htmlResponse(ADMIN_HTML);
}

async function handleAdminPost(env, request) {
  const contentType = request.headers.get("Content-Type") || "";
  let formData;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    formData = new URLSearchParams(await request.text());
  } else if (contentType.includes("multipart/form-data")) {
    formData = await request.formData();
  } else {
    formData = new URLSearchParams(await request.text());
  }

  const submitted = formData.get("token") || "";
  const expectedHash = env.REGISTER_TOKEN_HASH || "";

  // Always pick a theme for any "go back to login" path
  const theme = pickPrideTheme();

  // No hash configured → can't log in
  if (!expectedHash) {
    const html = renderAdminLoginPage({
      theme,
      errorHtml: '<p class="error">Admin pass not configured.</p>'
    });
    return htmlResponse(html, { status: 500 });
  }

  // Hash the token the user typed
  const submittedHash = await hashString(submitted);

  if (submittedHash !== expectedHash) {
    const html = renderAdminLoginPage({
      theme,
      errorHtml: '<p class="error">Incorrect admin pass.</p>'
    });
    return htmlResponse(html, { status: 401 });
  }

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Set-Cookie":
      "anarchy_admin=1; Path=/gg; HttpOnly; SameSite=Lax; Secure"
  });

  return new Response(ADMIN_HTML, { status: 200, headers });
}

async function handleAdminLogout(env, request) {
  const headers = new Headers({
    "Set-Cookie":
      "anarchy_admin=; Path=/gg; HttpOnly; SameSite=Lax; Secure; Max-Age=0",
    "Location": "/gg"
  });

  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }

  return new Response(null, { status: 302, headers });
}

async function handleAdminListDids(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const dids = [];
  let cursor = undefined;

  while (true) {
    const { keys, cursor: next } = await env.anarchydids.list({
      prefix: DID_PREFIX,
      cursor
    });

    for (const k of keys) {
      const didKey = k.name;
      const did = didKey.slice(DID_PREFIX.length);

      const raw = await env.anarchydids.get(didKey);
      if (!raw) continue;

      let rec;
      try {
        rec = JSON.parse(raw);
      } catch {
        // corrupt entry; skip
        continue;
      }

      // normalize handles (string or object)
      const rawHandles = Array.isArray(rec.handles) ? rec.handles : [];
      const handles = rawHandles
        .map(h => {
          // legacy string format
          if (typeof h === "string") {
            return { sub: h, createdAt: rec.createdAt || null };
          }
          // new object format
          if (h && typeof h.sub === "string") {
            return {
              sub: h.sub,
              createdAt: h.createdAt || rec.createdAt || null
            };
          }
          return null;
        })
        .filter(Boolean);

      dids.push({
        did,
        handles
      });
    }

    if (!next) break;
    cursor = next;
  }

  return jsonResponse({ dids });
}
async function handleAdminBackfillDidRecords(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;

  let cursor = undefined;

  while (true) {
    const { keys, cursor: next } = await env.anarchydids.list({
      prefix: SUB_PREFIX,
      cursor
    });

    for (const k of keys) {
      const subKey = k.name;
      const sub = subKey.slice(SUB_PREFIX.length);

      // Read sub record: { did, createdAt }
      const subRec = await env.anarchydids.get(subKey, "json");
      if (!subRec || !subRec.did) continue;

      const did = subRec.did;
      const didKey = DID_PREFIX + did;

      let didRecord = await env.anarchydids.get(didKey, "json");

      if (!didRecord) {
        // No DID record yet → create fresh one
        didRecord = {
          createdAt: subRec.createdAt || now,
          handles: [{ sub, createdAt: subRec.createdAt || now }]
        };
        created += 1;
      } else {
        // Normalize handles: accept strings or objects
        if (!Array.isArray(didRecord.handles)) didRecord.handles = [];

        const hasAlready = didRecord.handles.some(h => {
          if (typeof h === "string") return h === sub;
          return h && h.sub === sub;
        });

        if (!hasAlready) {
          didRecord.handles.push({
            sub,
            createdAt:
              subRec.createdAt || didRecord.createdAt || now
          });
          updated += 1;
        }
      }

      await env.anarchydids.put(didKey, JSON.stringify(didRecord));
    }

    if (!next) break;
    cursor = next;
  }

  return jsonResponse({
    ok: true,
    createdDidRecords: created,
    updatedDidRecords: updated
  });
}

async function handleAdminDeleteHandle(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await parseJson(request);
  const did = body.did;
  const rawSub = body.sub || body.subdomain;
  const sub = normalizeSubdomain(rawSub || "");

  if (!did || !sub) {
    return jsonResponse(
      { error: "You must provide both did and subdomain." },
      { status: 400 }
    );
  }

  const didKey = DID_PREFIX + did;
  const subKey = SUB_PREFIX + sub;

  const didRecord = await env.anarchydids.get(didKey, "json");
  const subRecord = await env.anarchydids.get(subKey, "json");

  if (!subRecord) {
    return jsonResponse(
      { error: "No handle record found for that subdomain." },
      { status: 404 }
    );
  }

  if (subRecord.did !== did) {
    return jsonResponse(
      { error: "That subdomain is not owned by the given DID." },
      { status: 400 }
    );
  }

  if (!didRecord) {
    await env.anarchydids.delete(subKey);
    return jsonResponse({
      ok: true,
      did,
      deleted_handle: sub + "." + BASE_DOMAIN,
      removed_did: true
    });
  }

  const handles = Array.isArray(didRecord.handles)
    ? didRecord.handles
    : [];
  const remaining = handles.filter(h => h.sub !== sub);

  await env.anarchydids.delete(subKey);

  let removedDid = false;
  if (!remaining.length) {
    await env.anarchydids.delete(didKey);
    removedDid = true;
  } else {
    didRecord.handles = remaining;
    await env.anarchydids.put(didKey, JSON.stringify(didRecord));
  }

  await logActivity(env, {
    ts: new Date().toISOString(),
    type: "delete",
    did,
    sub,
    pdsHost: null
  });

  return jsonResponse({
    ok: true,
    did,
    deleted_handle: sub + "." + BASE_DOMAIN,
    removed_did: removedDid
  });
}

async function handleAdminConfigGet(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const vipCfg = await loadVipConfig(env);
  const blockCfg = await loadBlockConfig(env);
  const reservedCfg = await loadReservedConfig(env);

  return jsonResponse({
    vipDids: vipCfg.vipDids,
    blockDids: blockCfg.blockDids,
    blockPds: blockCfg.blockPds,
    blockedKeywords: blockCfg.blockedKeywords || {},
    reservedHandles: reservedCfg.reservedHandles || {},
    maxHandlesPerDid: MAX_HANDLES_PER_DID,
    maxActivityEvents: MAX_ACTIVITY_EVENTS
  });
}

async function handleAdminConfigPost(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await parseJson(request);
  const vipCfg = await loadVipConfig(env);
  const blockCfg = await loadBlockConfig(env);
  const reservedCfg = await loadReservedConfig(env);

  if (body.addVipDid) vipCfg.vipDids[body.addVipDid] = true;
  if (body.removeVipDid) delete vipCfg.vipDids[body.removeVipDid];

  if (body.addBlockDid) blockCfg.blockDids[body.addBlockDid] = true;
  if (body.removeBlockDid) delete blockCfg.blockDids[body.removeBlockDid];

  if (body.addBlockPds) blockCfg.blockPds[body.addBlockPds] = true;
  if (body.removeBlockPds) delete blockCfg.blockPds[body.removeBlockPds];

  // 🔹 RESERVED HANDLES
  if (body.addReservedHandle) {
    const h = String(body.addReservedHandle).trim().toLowerCase();
    if (h) {
      reservedCfg.reservedHandles[h] = true;
    }
  }
  if (body.removeReservedHandle) {
    delete reservedCfg.reservedHandles[body.removeReservedHandle];
  }
  // 🔹 BLOCKED HANDLE KEYWORDS (slurs etc.)
  if (!blockCfg.blockedKeywords) {
    blockCfg.blockedKeywords = {};
  }

  if (body.addBlockedKeyword) {
    const kw = String(body.addBlockedKeyword).trim().toLowerCase();
    if (kw) {
      blockCfg.blockedKeywords[kw] = true;
    }
  }
  if (body.removeBlockedKeyword) {
    delete blockCfg.blockedKeywords[body.removeBlockedKeyword];
  }

  await saveVipConfig(env, vipCfg);
  await saveBlockConfig(env, blockCfg);
  await saveReservedConfig(env, reservedCfg);

  return jsonResponse({ ok: true });
}
//ADMIN HANDLE EXPORT & IMPORT
async function handleAdminExportConfig(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const vipCfg = await loadVipConfig(env);
  const blockCfg = await loadBlockConfig(env);
  const reservedCfg = await loadReservedConfig(env);

  const payload = {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    vipDids: vipCfg.vipDids || {},
    blockDids: blockCfg.blockDids || {},
    blockPds: blockCfg.blockPds || {},
    reservedHandles: reservedCfg.reservedHandles || {}
  };

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="anarchy-config-${payload.exportedAt.slice(0,10)}.json"`
    }
  });
}

async function handleAdminImportConfig(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await parseJson(request);

  const vipCfg = {
    vipDids: (body.vipDids && typeof body.vipDids === "object") ? body.vipDids : {}
  };
  const blockCfg = {
    blockDids: (body.blockDids && typeof body.blockDids === "object") ? body.blockDids : {},
    blockPds: (body.blockPds && typeof body.blockPds === "object") ? body.blockPds : {}
  };
  const reservedCfg = {
    reservedHandles: (body.reservedHandles && typeof body.reservedHandles === "object")
      ? body.reservedHandles
      : {}
  };

  await saveVipConfig(env, vipCfg);
  await saveBlockConfig(env, blockCfg);
  await saveReservedConfig(env, reservedCfg);

  return jsonResponse({ ok: true, message: "Config imported." });
}

async function handleAdminActivity(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }
  const data = await loadRecentActivity(env);
  return jsonResponse(data);
}
//ADMIN REGISTRY EXPORT & IMPORT
async function handleAdminExportRegistry(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();

  const records = [];
  let cursor = undefined;

  while (true) {
    const { keys, cursor: next } = await env.anarchydids.list({
      prefix: DID_PREFIX,
      cursor
    });

    for (const k of keys) {
      const didKey = k.name;
      const did = didKey.slice(DID_PREFIX.length);
      const rec = await env.anarchydids.get(didKey, "json");
      if (!rec) continue;

      const handles = Array.isArray(rec.handles) ? rec.handles : [];

      records.push({
        did,
        keyHash: rec.keyHash || null,
        createdAt: rec.createdAt || null,
        handles: handles.map(h => ({
          sub: h.sub,
          createdAt: h.createdAt || null
        }))
      });
    }

    if (!next) break;
    cursor = next;
  }

  const exportedAt = new Date().toISOString();

  if (format === "json") {
    const payload = {
      version: VERSION,
      exportedAt,
      records
    };
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="anarchy-registry-${exportedAt.slice(0,10)}.json"`
      }
    });
  }

  if (format === "csv") {
    const header = [
      "did",
      "subdomain",
      "full_handle",
      "did_created_at",
      "handle_created_at",
      "key_hash"
    ].join(",");

    const lines = [header];

    for (const rec of records) {
      const did = rec.did || "";
      const didCreated = rec.createdAt || "";
      const keyHash = rec.keyHash || "";

      if (!Array.isArray(rec.handles) || rec.handles.length === 0) {
        continue;
      }

      for (const h of rec.handles) {
        const sub = h.sub || "";
        const full = sub ? `${sub}.${BASE_DOMAIN}` : "";
        const hCreated = h.createdAt || "";

        const row = [
          did,
          sub,
          full,
          didCreated,
          hCreated,
          keyHash
        ].map(v => {
          if (v == null) return "";
          const s = String(v);
          if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        }).join(",");

        lines.push(row);
      }
    }

    const csv = lines.join("\n");
    const filename = `anarchy-registry-${exportedAt.slice(0,10)}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`
      }
    });
  }

  return jsonResponse(
    { error: 'Unsupported format. Use "json" or "csv".' },
    { status: 400 }
  );
}

async function handleAdminImportRegistry(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await parseJson(request);

  // Accept either {records:[...]} or an array directly
  const records = Array.isArray(body)
    ? body
    : (Array.isArray(body.records) ? body.records : []);

  if (!records.length) {
    return jsonResponse(
      { error: "No records provided for import." },
      { status: 400 }
    );
  }

  const nowIso = new Date().toISOString();

  // 1) Wipe existing DID + SUB registry (but leave config keys alone)
  // Clear DID:<did>
  {
    let cursor = undefined;
    while (true) {
      const { keys, cursor: next } = await env.anarchydids.list({
        prefix: DID_PREFIX,
        cursor
      });

      for (const k of keys) {
        await env.anarchydids.delete(k.name);
      }

      if (!next) break;
      cursor = next;
    }
  }

  // Clear SUB:<sub>
  {
    let cursor = undefined;
    while (true) {
      const { keys, cursor: next } = await env.anarchydids.list({
        prefix: SUB_PREFIX,
        cursor
      });

      for (const k of keys) {
        await env.anarchydids.delete(k.name);
      }

      if (!next) break;
      cursor = next;
    }
  }

  // 2) Recreate DID + SUB records from backup
  for (const rec of records) {
    if (!rec || !rec.did) continue;

    const did = rec.did;
    const didKey = DID_PREFIX + did;

    const handles = Array.isArray(rec.handles) ? rec.handles : [];
    const createdAt = rec.createdAt || nowIso;
    const keyHash = rec.keyHash || null;

    const didRecord = {
      keyHash,
      createdAt,
      handles: handles
        .filter(h => h && h.sub)
        .map(h => ({
          sub: h.sub,
          createdAt: h.createdAt || nowIso
        }))
    };

    // Write DID record
    await env.anarchydids.put(didKey, JSON.stringify(didRecord));

    // Write all SUB records
    for (const h of handles) {
      if (!h || !h.sub) continue;
      const subKey = SUB_PREFIX + h.sub;
      await env.anarchydids.put(
        subKey,
        JSON.stringify({
          did,
          createdAt: h.createdAt || nowIso
        })
      );
    }
  }

  return jsonResponse({ ok: true, imported: records.length });
}

async function handleAdminMetrics(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const now = Date.now();
  const oneHourAgo = now - 3600 * 1000;

  // 1) Registrations + PDS attempts (from activity log)
  const activity = await loadRecentActivity(env);
  const events = Array.isArray(activity.events) ? activity.events : [];

  let registrationsLastHour = 0;
  const pdsCounts = {};

  for (const ev of events) {
    if (!ev || !ev.ts) continue;
    const tsMs = Date.parse(ev.ts);
    if (!Number.isFinite(tsMs) || tsMs < oneHourAgo) continue;

    // count registrations (including admin-assigned reserved handles)
    if (ev.type === "register" || ev.type === "admin_assign_reserved") {
      registrationsLastHour++;
      if (ev.pdsHost) {
        const host = String(ev.pdsHost).toLowerCase();
        pdsCounts[host] = (pdsCounts[host] || 0) + 1;
      }
    }

    // also treat blocked PDS attempts as "attempts" for that host
    if (ev.type === "register_blocked_pds" && ev.pdsHost) {
      const host = String(ev.pdsHost).toLowerCase();
      pdsCounts[host] = (pdsCounts[host] || 0) + 1;
    }
  }

  const topPds = Object.entries(pdsCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([host, count]) => ({ host, count }));

  // 2) Recent IP spikes from the rateip:* keys (current hour bucket)
  const hourBucket = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const ipCounts = [];
  let cursor = undefined;

  while (true) {
    const { keys, cursor: next } = await env.anarchydids.list({
      prefix: "rateip:",
      cursor
    });

    for (const k of keys) {
      const name = k.name; // rateip:<ip>:YYYY-MM-DDTHH
      const parts = name.split(":");
      if (parts.length < 3) continue;

      const bucket = parts[parts.length - 1];
      const ip = parts.slice(1, parts.length - 1).join(":");

      if (bucket !== hourBucket) continue;

      const raw = await env.anarchydids.get(name);
      const count = raw ? parseInt(raw, 10) : 0;
      if (!count || Number.isNaN(count)) continue;

      ipCounts.push({ ip, count });
    }

    if (!next) break;
    cursor = next;
  }

  ipCounts.sort((a, b) => b.count - a.count);
  const ipSpikes = ipCounts.slice(0, 5); // top 5 noisy IPs this hour

  return jsonResponse({
    registrationsLastHour,
    topPds,
    ipSpikes
  });
}
async function handleInternalDidWebSync(request, env) {
  // ---------------------------------------------------------------------------
  // 1. Auth
  // ---------------------------------------------------------------------------
  const expected = env.INTERNAL_DIDWEB_SYNC_TOKEN;
  const auth = request.headers.get("Authorization") || "";
  if (!expected || !auth.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "missing-auth" }, { status: 401 });
  }
  const token = auth.slice("Bearer ".length).trim();
  if (token !== expected) {
    return jsonResponse({ ok: false, error: "invalid-auth" }, { status: 401 });
  }

  // ---------------------------------------------------------------------------
  // 2. Parse body
  // ---------------------------------------------------------------------------
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: "invalid-json" }, { status: 400 });
  }

  const { did, host, handle, note } = body || {};
  if (!did || !handle) {
    return jsonResponse(
      { ok: false, error: "missing-fields", need: ["did", "handle"] },
      { status: 400 }
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Derive subdomain <sub>
  // ---------------------------------------------------------------------------
  const sub = deriveSubdomain(handle, host);
  if (!sub) {
    return jsonResponse(
      { ok: false, error: "bad-handle", detail: handle },
      { status: 400 }
    );
  }

  const now = Date.now();
  const subKey = `sub:${sub}`;
  const didKey = `did:${did}`;

  // ---------------------------------------------------------------------------
  // 4. Load existing rows
  // ---------------------------------------------------------------------------
  const existingSubRaw = await env.anarchydids.get(subKey);
  const existingSub = existingSubRaw ? JSON.parse(existingSubRaw) : null;

  const existingDidRaw = await env.anarchydids.get(didKey);
  const existingDid = existingDidRaw ? JSON.parse(existingDidRaw) : null;

  // ---------------------------------------------------------------------------
  // 5. Conflict: sub:<sub> exists with a DIFFERENT did
  // ---------------------------------------------------------------------------
  if (existingSub && existingSub.did && existingSub.did !== did) {
    return jsonResponse(
      {
        ok: false,
        error: "handle-already-bound",
        existingDid: existingSub.did,
        requestedDid: did
      },
      { status: 409 }
    );
  }

  // ---------------------------------------------------------------------------
  // 6. Update or create sub:<sub>
  // ---------------------------------------------------------------------------
  const updatedSub = {
    ...(existingSub || {}),
    did,
    updatedAt: now,
    note: note ?? existingSub?.note ?? null,
    // If user-created, keep that; if new or already didweb, use didweb
    source:
      existingSub?.source && existingSub?.source !== "didweb"
        ? existingSub.source
        : "didweb"
  };

  // If brand new, set createdAt
  if (!existingSub) {
    updatedSub.createdAt = now;
  }

  await env.anarchydids.put(subKey, JSON.stringify(updatedSub));

  // ---------------------------------------------------------------------------
  // 7. Update or create did:<did>.handles[]
  // ---------------------------------------------------------------------------
  let didRow = existingDid || {
    keyHash: null,
    createdAt: now,
    handles: []
  };

  let handles = didRow.handles || [];
  const ix = handles.findIndex((h) => h.sub === sub);

  if (ix !== -1) {
    // refresh existing handle
    handles[ix] = {
      ...handles[ix],
      updatedAt: now,
      note: note ?? handles[ix].note ?? null,
      source:
        handles[ix].source && handles[ix].source !== "didweb"
          ? handles[ix].source
          : "didweb"
    };
  } else {
    // add new
    handles.push({
      sub,
      createdAt: now,
      updatedAt: now,
      note: note ?? null,
      source: "didweb"
    });
  }

  didRow.updatedAt = now;
  didRow.handles = handles;

  await env.anarchydids.put(didKey, JSON.stringify(didRow));

  // ---------------------------------------------------------------------------
  // 8. Logging for auditability
  // ---------------------------------------------------------------------------
  console.log("[didweb-sync]", {
    sub,
    did,
    host,
    note,
    timestamp: now,
    outcome: "ok"
  });

  // ---------------------------------------------------------------------------
  // 9. Return to Root
  // ---------------------------------------------------------------------------
  return jsonResponse({
    ok: true,
    did,
    handle,
    subdomain: sub,
    updatedSub,
    didRow
  });
}

// Helpers ---------------------------------------------------------------------

function deriveSubdomain(handle, host) {
  // Primary approach: <sub>.anarchy.lgbt → extract <sub>
  if (handle && handle.includes(".")) {
    const [maybeSub] = handle.split(".");
    if (maybeSub) return maybeSub.toLowerCase();
  }

  // Fallback: if Root sends host (e.g. "example.anarchy.lgbt")
  if (host && host.includes(".")) {
    const [maybeSub] = host.split(".");
    if (maybeSub) return maybeSub.toLowerCase();
  }

  return null;
}


async function handleAdminResolve(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }
  const body = await parseJson(request);
  const handle = body.handle || "";
  const did = await resolveDidFromHandle(handle);
  if (!did) {
    return jsonResponse(
      { ok: false, error: "Could not resolve DID for this handle." },
      { status: 400 }
    );
  }
  return jsonResponse({ ok: true, did });
}

async function handleAdminDeleteAllForDid(env, request) {
  if (!isAdmin(request)) {
    return new Response("Not found", { status: 404 });
  }

  const body = await parseJson(request);
  const did = (body.did || "").trim();

  if (!did) {
    return jsonResponse(
      { error: "You must provide a DID." },
      { status: 400 }
    );
  }

  const registry = env.anarchydids;
  const didKey = DID_PREFIX + did;

  const didRecord = await registry.get(didKey, "json");
  if (!didRecord) {
    return jsonResponse(
      { error: "No registry record found for that DID." },
      { status: 404 }
    );
  }

  const handles = Array.isArray(didRecord.handles) ? didRecord.handles : [];

  // Delete all sub:<sub> entries
  for (const h of handles) {
    if (!h || !h.sub) continue;
    const subKey = SUB_PREFIX + h.sub;
    await registry.delete(subKey);
  }

  // Delete the DID record itself
  await registry.delete(didKey);

  // Log a special admin override event
  await logActivity(env, {
    ts: new Date().toISOString(),
    type: "admin_delete_all",
    did,
    sub: null,
    pdsHost: null
  });

  return jsonResponse({
    ok: true,
    did,
    deletedHandles: handles.map(h => h.sub).filter(Boolean),
    removedDid: true
  });
}

async function handleAdminAssignReserved(env, request) {
  if (!isAdmin(request)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await parseJson(request);
  const did = (body.did || "").trim();
  const sub = normalizeSubdomain(body.sub || "");

  if (!did || !sub) {
    return jsonResponse(
      { error: "You must provide both did and sub." },
      { status: 400 }
    );
  }

  // Must be in reserved list
  const reservedCfg = await loadReservedConfig(env);
  if (!reservedCfg.reservedHandles || !reservedCfg.reservedHandles[sub]) {
    return jsonResponse(
      { error: "This subdomain is not reserved." },
      { status: 400 }
    );
  }

  const subKey = SUB_PREFIX + sub;
  const existing = await env.anarchydids.get(subKey);
  if (existing) {
    return jsonResponse(
      { error: "This reserved handle is already assigned." },
      { status: 409 }
    );
  }

  const didKey = DID_PREFIX + did;
  let record = await env.anarchydids.get(didKey, "json");
  const now = new Date().toISOString();

  let secretKey = null;

  if (!record) {
    // New DID in this registry → generate secret key
    secretKey = generateSecretKey();
    const keyHash = await hashString(secretKey);
    record = {
      keyHash,
      createdAt: now,
      handles: [{ sub, createdAt: now }]
    };
  } else {
    if (!Array.isArray(record.handles)) record.handles = [];
    // Put reserved handle in front
    record.handles.unshift({ sub, createdAt: now });
  }

  await env.anarchydids.put(didKey, JSON.stringify(record));
  await env.anarchydids.put(subKey, JSON.stringify({ did, createdAt: now }));

  await logActivity(env, {
    ts: now,
    type: "admin_assign_reserved",
    did,
    sub,
    pdsHost: null
  });

  return jsonResponse({
    ok: true,
    did,
    sub,
    handle: sub + "." + BASE_DOMAIN,
    secret_key: secretKey
  });
}
// -------------------------------------------
// OPTION C — FORTRESS-GRADE HANDLE VALIDATOR
// -------------------------------------------

// Unicode invisibles & control chars
const INVISIBLE_REGEX =
  /[\u0000-\u001F\u007F\u00A0\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F\u2060\u3000\uFEFF]/g;

// Basic Latin a-z / 0-9 / hyphen only
const ASCII_LOWER = /^[a-z0-9-]+$/;

// Domain validation (strict, no tricks)
function isSupportedDomain(domain, SUPPORTED_DOMAINS) {
  if (!domain) return false;

  const d = String(domain).trim().toLowerCase();

  // Disallow punycode
  if (d.startsWith("xn--")) return false;

  return SUPPORTED_DOMAINS.includes(d);
}

// Normalize input to NFC + strip invisibles
function sanitizeLocalPart(local) {
  if (!local) return "";

  let clean = String(local).normalize("NFC");
  clean = clean.replace(INVISIBLE_REGEX, "");
  clean = clean.toLowerCase();

  return clean;
}

function validateLocalPart(rawLocal) {
  const local = sanitizeLocalPart(rawLocal);

  // Length
  if (local.length < 4 || local.length > 40) {
    return { ok: false, error: "Handle must be 4 to 40 characters long." };
  }

  // ASCII-only rule
  if (!ASCII_LOWER.test(local)) {
    return { ok: false, error: "Handle can only use a–z, 0–9, and hyphens." };
  }

  // No leading or trailing hyphen
  if (local.startsWith("-") || local.endsWith("-")) {
    return { ok: false, error: "Handle cannot start or end with a hyphen." };
  }

  // No double hyphens
  if (local.includes("--")) {
    return {
      ok: false,
      error: "Handle cannot contain consecutive hyphens.",
    };
  }

  return { ok: true, local };
}
function extractSubForDidWebSync(handle) {
  const h = handle.trim().toLowerCase();
  const suffix = "." + BASE_DOMAIN;

  if (!h.endsWith(suffix)) return null;

  const sub = h.slice(0, h.length - suffix.length);
  if (!sub) return null;

  // basic safety checks
  if (sub.includes("/") || sub.includes("@") || /\s/.test(sub)) return null;

  return sub;
}

function validateFullHandle(local, domain, SUPPORTED_DOMAINS) {
  const v = validateLocalPart(local);
  if (!v.ok) return v;

  if (!isSupportedDomain(domain, SUPPORTED_DOMAINS)) {
    return { ok: false, error: `Domain ${domain} is not allowed.` };
  }

  return { ok: true, local: v.local, domain: domain.toLowerCase() };
}
async function handlePdsRequest(env, request) {
  const backend = env.PDS_BACKEND_ORIGIN;
  const url = new URL(request.url);
  const path = url.pathname;


  // --- Intercept account deletion ---
  if (path === "/xrpc/com.atproto.server.deleteAccount") {
    return handleProxyDeleteAccount(env, request);
  }

  // --- Everything else: just proxy ---
  const backendUrl = backend + url.pathname + url.search;
  const req = new Request(backendUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow"
  });

  return fetch(req);
}
async function handleProxyDeleteAccount(env, request) {
  const backend = env.PDS_BACKEND_ORIGIN;
  const url = new URL(request.url);

  // Identify DID before deletion
  let did = null;
  try {
    const sessionRes = await fetch(
      backend + "/xrpc/com.atproto.server.getSession",
      {
        headers: {
          "authorization": request.headers.get("authorization") || "",
          "cookie": request.headers.get("cookie") || ""
        }
      }
    );
    if (sessionRes.ok) {
      const session = await sessionRes.json();
      did = session.did;
    }
  } catch {}

  // Forward deleteAccount to backend
  const pdsRes = await fetch(backend + url.pathname + url.search, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  const body = await pdsRes.text();
  const responseForClient = new Response(body, {
    status: pdsRes.status,
    headers: pdsRes.headers
  });

  if (!pdsRes.ok) return responseForClient;

  // If DID known → clean registry
  if (did) {
    await deleteRegistryForDid(env, did);
  }

  return responseForClient;
}

// ---------------------------------------------------------
// Router
// ---------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const isPdsHost = host === "pds.anarchy.lgbt"

  // All traffic for the commune PDS goes through this branch
    if (host === "pds.anarchy.lgbt") {
      return handlePdsRequest(env, request);
    }
    // internal did:web → registry sync endpoint
    if (url.pathname === "/internal/didweb-sync" && request.method === "POST") {
      return handleInternalDidWebSync(request, env);
    }

    // Example: API endpoint the signup form POSTs to
    if (url.pathname === "/api/signup" && request.method === "POST") {
      return handleSignupRequest(request, env);
    }
 
    if (isPdsHost) {
      return handlePdsRequest(env, request);
    }
    // Internal debug: lookup did:<did>
    // GET /internal/debug/did?did=<did>
    // Auth: Bearer INTERNAL_DIDWEB_SYNC_TOKEN
    // ========================================
    if (url.pathname === "/internal/debug/did" && request.method === "GET") {
      return handleDebugDid(request, env);
    }

    
    function parseHandleParts(handle, supportedDomains) {
      const handleLower = (handle || "").toLowerCase().trim();
      if (!handleLower) return null;

      const domain = supportedDomains.find(d =>
        handleLower.endsWith("." + d)
      );
      if (!domain) return null;

      const suffix = "." + domain;
      const local = handleLower.slice(0, handleLower.length - suffix.length);
      if (!local) return null;

      return { local, domain, handleLower };
    }

    async function deleteRegistryForDid(env, did) {
      const didStr = String(did);
      const didKey = DID_PREFIX + didStr;
      const existingDidRaw = await env.anarchydids.get(didKey);
      if (!existingDidRaw) {
        return;
      }
    
      let didRecord;
      try {
        didRecord = JSON.parse(existingDidRaw) || {};
      } catch {
        didRecord = {};
      }
    
      const handles = Array.isArray(didRecord.handles) ? didRecord.handles : [];
      const subs = handles
        .map(h => (typeof h === "string" ? h : h && h.sub))
        .filter(Boolean);
    
      // Delete sub:<sub> entries that belong to this DID
      for (const sub of subs) {
        const subKey = SUB_PREFIX + sub;
        const subRaw = await env.anarchydids.get(subKey);
        if (!subRaw) continue;
    
        try {
          const subRec = JSON.parse(subRaw) || {};
          if (subRec.did === didStr) {
            await env.anarchydids.delete(subKey);
          }
        } catch {
          // Corrupt? Just delete it.
          await env.anarchydids.delete(subKey);
        }
      }
    
      // Finally delete did:<did> record
      await env.anarchydids.delete(didKey);
    }
    
    async function handleProxyDeleteAccount(env, request) {
      const backendUrl = new URL(request.url);
      backendUrl.host = new URL(env.PDS_BACKEND_ORIGIN).host;
    
      let did = null;
    
      try {
        // Try to get DID from getSession *before* deletion
        const sessionUrl = new URL(env.PDS_BACKEND_ORIGIN);
        sessionUrl.pathname = "/xrpc/com.atproto.server.getSession";
    
        const authHeader = request.headers.get("Authorization") || "";
        const expected = "Bearer " + env.INTERNAL_DIDWEB_SYNC_TOKEN;
        
            
        const sessionRes = await fetch(sessionUrl.toString(), {
          method: "GET",
          headers: {
            "Authorization": authHeader,
            "Cookie": cookies
          }
        });
    
        if (sessionRes.ok) {
          const session = await sessionRes.json();
          if (session && session.did) {
            did = session.did;
          }
        }
      } catch (err) {
        console.warn("deleteAccount: getSession failed", err);
      }
    
      // Forward deleteAccount to backend
      const reqClone = new Request(backendUrl.toString(), request);
      const pdsRes = await fetch(reqClone);
      const body = await pdsRes.text();
      const resForClient = new Response(body, {
        status: pdsRes.status,
        headers: pdsRes.headers
      });
    
      if (!pdsRes.ok) {
        return resForClient;
      }
    
      // If we got a DID earlier, clean registry
      if (did) {
        try {
          await deleteRegistryForDid(env, did);
        } catch (err) {
          console.error("deleteAccount: registry cleanup failed", err);
        }
      }
    
      return resForClient;
    }
    async function changeRegistryHandle(env, did, oldSub, newSub) {
      const didStr = String(did);
      const now = new Date().toISOString();
    
      // Normalize
      oldSub = oldSub.toLowerCase().trim();
      newSub = newSub.toLowerCase().trim();
    
      // 1) Update did:<did> record
      const didKey = DID_PREFIX + didStr;
      const existingDidRaw = await env.anarchydids.get(didKey);
      if (!existingDidRaw) return;
    
      let didRecord;
      try {
        didRecord = JSON.parse(existingDidRaw) || {};
      } catch {
        didRecord = {};
      }
    
      const baseCreated = didRecord.createdAt || now;
      const rawHandles = Array.isArray(didRecord.handles) ? didRecord.handles : [];
      let changed = false;
    
      const normalizedHandles = rawHandles
        .map(h => {
          if (typeof h === "string") {
            if (h === oldSub) {
              changed = true;
              return { sub: newSub, createdAt: baseCreated };
            }
            return { sub: h, createdAt: baseCreated };
          }
          if (h && typeof h.sub === "string") {
            if (h.sub === oldSub) {
              changed = true;
              return {
                sub: newSub,
                createdAt: h.createdAt || baseCreated
              };
            }
            return {
              sub: h.sub,
              createdAt: h.createdAt || baseCreated
            };
          }
          return null;
        })
        .filter(Boolean);
    
      if (!changed) {
        // If oldSub not found, just append newSub entry
        normalizedHandles.push({ sub: newSub, createdAt: now });
      }
    
      didRecord.createdAt = baseCreated;
      didRecord.handles = normalizedHandles;
      await env.anarchydids.put(didKey, JSON.stringify(didRecord));
    
      // 2) Update sub:<oldSub> and sub:<newSub>
      const oldSubKey = SUB_PREFIX + oldSub;
      const oldSubRaw = await env.anarchydids.get(oldSubKey);
      if (oldSubRaw) {
        try {
          const oldRec = JSON.parse(oldSubRaw) || {};
          if (oldRec.did === didStr) {
            await env.anarchydids.delete(oldSubKey);
          }
        } catch {
          await env.anarchydids.delete(oldSubKey);
        }
      }
    
      const newSubKey = SUB_PREFIX + newSub;
      const newSubRecord = {
        did: didStr,
        createdAt: now
      };
      await env.anarchydids.put(newSubKey, JSON.stringify(newSubRecord));
    }
    async function setRegistryHandle(env, did, subdomain) {
      const didStr = String(did);
      const sub = subdomain.toLowerCase().trim();
      const now = new Date().toISOString();
    
      // --- sub:<sub> -> { did, createdAt } ---
      const subKey = SUB_PREFIX + sub;
      const existingSubRaw = await env.anarchydids.get(subKey);
      let existingSub = null;
    
      if (existingSubRaw) {
        try {
          existingSub = JSON.parse(existingSubRaw);
        } catch {
          // if corrupt, we'll just overwrite
        }
      }
    
      const subRecord = {
        did: didStr,
        createdAt: (existingSub && existingSub.createdAt) || now
      };
    
      await env.anarchydids.put(subKey, JSON.stringify(subRecord));
    
      // --- did:<did> -> { createdAt, keyHash?, handles[] } ---
      const didKey = DID_PREFIX + didStr;
      const existingDidRaw = await env.anarchydids.get(didKey);
    
      let didRecord = {
        createdAt: now,
        handles: []
      };
    
      if (existingDidRaw) {
        try {
          const parsedDid = JSON.parse(existingDidRaw) || {};
          if (parsedDid.createdAt) didRecord.createdAt = parsedDid.createdAt;
          if (parsedDid.keyHash) didRecord.keyHash = parsedDid.keyHash;
          if (Array.isArray(parsedDid.handles)) {
            didRecord.handles = parsedDid.handles
              .map(h => {
                if (typeof h === "string") {
                  return { sub: h, createdAt: didRecord.createdAt };
                }
                if (h && typeof h.sub === "string") {
                  return {
                    sub: h.sub,
                    createdAt: h.createdAt || didRecord.createdAt
                  };
                }
                return null;
              })
              .filter(Boolean);
          }
        } catch {
          // if corrupt, we rebuild from scratch
        }
      }
    
      // Ensure this sub is in handles[]
      const already = didRecord.handles.some(h => h.sub === sub);
      if (!already) {
        didRecord.handles.push({ sub, createdAt: now });
      }
    
      await env.anarchydids.put(didKey, JSON.stringify(didRecord));
    }
         
    async function handlePdsRequest(env, request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const backend = env.PDS_BACKEND_ORIGIN;
    
      // Intercept handle changes for automation
      if (path === "/xrpc/com.atproto.identity.updateHandle" && request.method === "POST") {
        return handleProxyUpdateHandle(env, request);
      }
    
      // Intercept account deletion for registry cleanup
      if (path === "/xrpc/com.atproto.server.deleteAccount" && request.method === "POST") {
        return handleProxyDeleteAccount(env, request);
      }
    
      // Everything else: just proxy straight to the backend PDS
      const backendUrl = backend + url.pathname + url.search;
      const proxiedReq = new Request(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "follow"
      });
    
      return fetch(proxiedReq);
    }
    async function handleProxyUpdateHandle(env, request) {
      const backend = env.PDS_BACKEND_ORIGIN;
      const url = new URL(request.url);
    
      // 1) Read the JSON body so we can see the *new* handle, then re-encode it.
      let payload = null;
      try {
        // clone() so we don't consume the original request body unexpectedly
        payload = await request.clone().json();
      } catch {
        payload = null;
      }
    
      const rawHandle =
        payload && typeof payload.handle === "string" ? payload.handle.trim() : "";
      const handleLower = rawHandle.toLowerCase();
    
      // We only care about the registry base domain here
      const suffix = "." + REGISTRY_BASE_DOMAIN; // e.g. ".anarchy.lgbt"
      let newSub = null;
      if (handleLower && handleLower.endsWith(suffix)) {
        newSub = handleLower.slice(0, handleLower.length - suffix.length); // "foo" from "foo.anarchy.lgbt"
      }
    
      let did = null;
    
      // 2) Pre-write registry:
      //    - If the new handle is an anarchy.lgbt handle, ensure sub -> DID mapping exists.
      //    - If the new handle is NOT an anarchy.lgbt handle, purge any registry entries for this DID.
      if (handleLower) {
        try {
          const sessionUrl = new URL(env.PDS_BACKEND_ORIGIN);
          sessionUrl.pathname = "/xrpc/com.atproto.server.getSession";
    
          const authHeader = request.headers.get("Authorization") || "";
          const cookies = request.headers.get("Cookie") || "";
    
          const sessionRes = await fetch(sessionUrl.toString(), {
            method: "GET",
            headers: {
              ...(authHeader ? { authorization: authHeader } : {}),
              ...(cookies ? { cookie: cookies } : {})
            }
          });
    
          if (!sessionRes.ok) {
            console.warn(
              "updateHandle: failed to getSession before pre-write, status=",
              sessionRes.status
            );
          } else {
            const session = await sessionRes.json();
            did = session && session.did;
    
            if (did) {
              if (newSub) {
                  // New handle is <sub>.anarchy.lgbt → ensure registry mapping
                  if (handleLower.endsWith(".anarchy.lgbt")) {
                    await setRegistryHandle(env, did, newSub);
                } else {
                  // New handle is NOT on REGISTRY_BASE_DOMAIN → remove from registry entirely
                  await deleteRegistryForDid(env, did);
                }
              }
            } else {
              console.warn(
                "updateHandle: missing did in getSession before pre-write"
              );
            }
          }
        } catch (err) {
          console.error("updateHandle: pre-write registry sync failed", err);
        }
      }
    
      // 3) Proxy updateHandle to backend PDS
      const backendUrl = backend + url.pathname + url.search;
    
      const proxiedReq = new Request(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: payload ? JSON.stringify(payload) : null
      });
    
      const pdsRes = await fetch(proxiedReq);
      const rawBody = await pdsRes.text();
    
      // 4) Return PDS response to client unchanged
      return new Response(rawBody, {
        status: pdsRes.status,
        headers: pdsRes.headers
      });
    }

  async function handleProxyDeleteAccount(env, request) {
    const backend = env.PDS_BACKEND_ORIGIN;
    const url = new URL(request.url);
  
    // 1) Read the JSON body once, extract DID
    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      // If we can't read JSON, just proxy without registry cleanup
      const backendUrl = backend + url.pathname + url.search;
      const proxiedReq = new Request(backendUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body
      });
      return fetch(proxiedReq);
    }
  
    const did = (payload.did || "").trim();
  
    // Re-encode body for backend request
    const bodyStr = JSON.stringify(payload);
  
    // 2) Proxy deleteAccount to backend PDS
    const backendUrl = backend + url.pathname + url.search;
    const proxiedReq = new Request(backendUrl, {
      method: request.method,
      headers: request.headers,
      body: bodyStr
    });
  
    const pdsRes = await fetch(proxiedReq);
    const rawBody = await pdsRes.text();
  
    const clientRes = new Response(rawBody, {
      status: pdsRes.status,
      headers: pdsRes.headers
    });
  
    if (!pdsRes.ok) {
      // PDS rejected deletion; don't touch registry
      return clientRes;
    }
  
    // 3) If we have a DID, clean up the registry for it
    if (did) {
      try {
        await deleteRegistryForDid(env, did);
      } catch (err) {
        console.error("deleteAccount: deleteRegistryForDid failed", err);
      }
    }
  
    return clientRes;
  }
      
  async function tryServeDidWebOverride(url, env) {
    const host = url.hostname.toLowerCase();
    const key = "didweb:host:" + host;
  
    let record;
    try {
      record = await env.ROOT_DIDWEB_KV.get(key, "json");
    } catch (err) {
      console.log("[didweb] KV get failed for", key, err);
      return null;
    }
  
    if (!record) return null;
    if (record.status && record.status !== "active") {
      // Allow you to “disable” configs later without deleting them
      return null;
    }
  
    const doc = record.doc;
    if (!doc || typeof doc !== "object") {
      console.log("[didweb] record for", host, "missing 'doc' field");
      return null;
    }
  
    // Optional: sanity-check ID
    const expectedId = "did:web:" + host;
    if (doc.id && doc.id !== expectedId) {
      console.log(
        "[didweb] ID mismatch for",
        host,
        "expected",
        expectedId,
        "got",
        doc.id
      );
      // We still serve it; you can tighten this later if you want.
    }
  
    const body = JSON.stringify(doc);
  
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    });
    }
  async function loadDidWebRecord(url, env) {
    const host = url.hostname.toLowerCase();
    const key = "didweb:host:" + host;
  
    try {
      const record = await env.ROOT_DIDWEB_KV.get(key, "json");
      if (!record) return null;
      if (record.status && record.status !== "active") return null;
      return record;
    } catch (err) {
      console.log("[didweb] KV get failed for", key, err);
      return null;
    }
  }
    
    // CSV like "anarchy.lgbt,pursuingpeace.app"
    const supportedDomains = (env.SUPPORTED_DOMAINS || "anarchy.lgbt")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

  if (isPdsHost && path === "/xrpc/com.atproto.identity.updateHandle" && method === "POST") {
    return handleProxyUpdateHandle(env, request);
  }
  async function handleDebugDid(request, env) {
    const expected = env.INTERNAL_DIDWEB_SYNC_TOKEN;
    const auth = request.headers.get("Authorization") || "";
    if (!expected || !auth.startsWith("Bearer ") || auth.slice(7).trim() !== expected) {
      return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  
    const url = new URL(request.url);
    const did = url.searchParams.get("did");
    if (!did) {
      return jsonResponse({ ok: false, error: "missing-did" }, { status: 400 });
    }
  
    const key = `did:${did}`;
    const raw = await env.anarchydids.get(key);
    if (!raw) {
      return jsonResponse({ ok: false, found: false, did }, { status: 200 });
    }
  
    let row;
    try {
      row = JSON.parse(raw);
    } catch (e) {
      return jsonResponse(
        {
          ok: false,
          found: true,
          did,
          parseError: true,
          raw
        },
        { status: 500 }
      );
    }
  
    return jsonResponse({ ok: true, found: true, did, row }, { status: 200 });
  }
         
  // -----------------------------
  // Signup proxy with validation + registry bridge
  // -----------------------------
  if (
    url.pathname === "/signup/xrpc/com.atproto.server.createAccount" &&
    request.method === "POST"
  ) {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: "invalid_json",
          message: "Request body must be JSON."
        }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }

  const { email, handle, password, inviteCode } = body || {};

  if (!email || !handle || !password || !inviteCode) {
    return new Response(
      JSON.stringify({
        error: "missing_required_fields",
        message: "email, handle, password, and inviteCode are required."
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const parts = parseHandleParts(handle, supportedDomains);
  if (!parts) {
    return new Response(
      JSON.stringify({
        error: "invalid_handle_domain",
        message: "Handle must end with a supported domain."
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const { local, domain, handleLower } = parts;

  // Length rule: 4–40 chars for the local part
  if (local.length < 4 || local.length > 40) {
    return new Response(
      JSON.stringify({
        error: "invalid_handle_length",
        message: "Handle must be between 4 and 40 characters before the domain."
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // Character rule: a–z, 0–9, . , -
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(local)) {
    return new Response(
      JSON.stringify({
        error: "invalid_handle_chars",
        message: "Handle may only use a–z, 0–9, dots, and dashes."
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  // Forward to the PDS (backend origin)
  const pdsOrigin = env.PDS_ORIGIN || "https://pds.anarchy.lgbt";
  const pdsUrl = `${pdsOrigin}/xrpc/com.atproto.server.createAccount`;

  const pdsRes = await fetch(pdsUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      email,
      handle: handleLower, // normalized
      password,
      inviteCode
    })
  });

  // We want both: the raw body to send back AND parsed JSON
  const rawBody = await pdsRes.text();
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  // If PDS signup succeeded and we got a DID, write into the registry directly
  if (pdsRes.ok && parsed && parsed.did) {
    if (handleLower.endsWith(".anarchy.lgbt")) {
      try {
        const did = String(parsed.did);
        const subdomain = local.toLowerCase().trim();
        const now = new Date().toISOString();

        // --- SUB_PREFIX: sub:<subdomain> -> { did, createdAt } ---
        const subKey = SUB_PREFIX + subdomain;
        const existingSubRaw = await env.anarchydids.get(subKey);
        let existingSub = null;

        if (existingSubRaw) {
          try {
            existingSub = JSON.parse(existingSubRaw);
          } catch {
            // corrupt? we’ll just overwrite below
          }
        }

        if (existingSub && existingSub.did && existingSub.did !== did) {
          // Someone else already has this handle; log it but don't blow up signup
          console.warn("signup registry write: handle already claimed by a different DID", {
            subdomain,
            existingDid: existingSub.did,
            did
          });
        } else {
          const subRecord = {
            did,
            createdAt:
              existingSub && existingSub.createdAt ? existingSub.createdAt : now
          };

          await env.anarchydids.put(subKey, JSON.stringify(subRecord));

          // --- DID_PREFIX: did:<did> -> { createdAt, keyHash?, handles[] } ---
          const didKey = DID_PREFIX + did;
          const existingDidRaw = await env.anarchydids.get(didKey);

          let didRecord = {
            createdAt: now,
            handles: []
          };

          if (existingDidRaw) {
            try {
              const parsedDid = JSON.parse(existingDidRaw) || {};

              // keep original createdAt if present
              if (parsedDid.createdAt) {
                didRecord.createdAt = parsedDid.createdAt;
              }

              // keep keyHash if this DID already has a secret key
              if (parsedDid.keyHash) {
                didRecord.keyHash = parsedDid.keyHash;
              }

              // normalize handles: accept strings *or* objects
              if (Array.isArray(parsedDid.handles)) {
                didRecord.handles = parsedDid.handles
                  .map(h => {
                    if (typeof h === "string") {
                      return { sub: h, createdAt: now };
                    }
                    if (h && typeof h.sub === "string") {
                      return {
                        sub: h.sub,
                        createdAt: h.createdAt || didRecord.createdAt || now
                      };
                    }
                    return null;
                  })
                  .filter(Boolean);
              }
            } catch {
              // if corrupt, we just rebuild from scratch
            }
          }

          // Add this subdomain if it's not already present
          const already = didRecord.handles.some(h => h.sub === subdomain);
          if (!already) {
            didRecord.handles.push({ sub: subdomain, createdAt: now });
          }

          await env.anarchydids.put(didKey, JSON.stringify(didRecord));
        }
      } catch (err) {
        console.error("PDS→registry inline bridge failed", err);
      }
    }
  }

  const respHeaders = new Headers();
  respHeaders.set(
    "content-type",
    pdsRes.headers.get("content-type") || "application/json"
  );

  return new Response(rawBody, {
    status: pdsRes.status,
    headers: respHeaders
  });
}
    // join.anarchy.lgbt intro page
    if (host === "join.anarchy.lgbt" && path === "/" && method === "GET") {
      return htmlResponse(renderJoinIntroPage()); // the big explainer you pasted
    }

    // join.anarchy.lgbt signup page (hosted on worker)
    if (host === "join.anarchy.lgbt" && path === "/signup" && method === "GET") {
      const domainsCsv = env.SUPPORTED_DOMAINS || "anarchy.lgbt";
      return htmlResponse(renderJoinSignupPage(domainsCsv));
    }
    
    // --- Bypass Worker only for the PDS host so it hits your VPS origin ---
    if (host === "pds.anarchy.lgbt") {
      return fetch(request);
    }

    // --- Public themes endpoint for join.anarchy.lgbt & others ---
    if (url.pathname === "/themes") {
      return new Response(JSON.stringify(PRIDE_THEMES), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300" // tweak if you want
        }
      });
    }

    // --- Internal PDS hook: change handle -> update registry ---
    if (url.pathname === "/internal/pds/change-handle" && request.method === "POST") {
      // Same bearer-token auth as /internal/pds/claim
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      if (!token || token !== env.PDS_BRIDGE_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const did = (payload.did || "").trim();
      const oldSub = (payload.oldSub || "").trim();
      const newSub = (payload.newSub || "").trim();

      if (!did || !oldSub || !newSub) {
        return new Response(
          JSON.stringify({ error: "did, oldSub, and newSub are required" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      await changeRegistryHandle(env, did, oldSub, newSub);

      return new Response(
        JSON.stringify({ ok: true, did, oldSub, newSub }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // --- AT Protocol HTTPS handle resolution: /.well-known/atproto-did ---
    if (url.pathname === "/.well-known/atproto-did") {
      // 1) Try did:web override from ROOT_DIDWEB_KV
      const record = await loadDidWebRecord(url, env);
      if (record && record.did) {
        return new Response(record.did, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=300"
          }
        });
      }
    
      // 2) Fall back to existing registry behavior for handles
      //    (this is whatever code you had before we added did:web stuff)
      //    Example placeholder:
      // return handleAtprotoDidFromRegistry(url, env);
    
      // If you don't have a helper, just paste your original logic here.
    }
    if (url.pathname === "/.well-known/did.json") {
      const record = await loadDidWebRecord(url, env);
    
      if (!record || !record.doc || typeof record.doc !== "object") {
        // You can choose 404 here, or some future default behavior.
        return new Response("did:web doc not found", { status: 404 });
      }
    
      const body = JSON.stringify(record.doc);
    
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300"
        }
      });
    }
    
        // --- Internal PDS bridge: write DID↔subdomain mapping into KV ---
    if (url.pathname === "/internal/pds/claim" && request.method === "POST") {
      // Simple bearer token auth
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      if (!token || token !== env.PDS_BRIDGE_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return new Response("Invalid JSON", { status: 400 });
      }

      const subdomain = (payload.subdomain || "").toLowerCase().trim();
      const did = (payload.did || "").trim();

      if (!subdomain || !did || !did.startsWith("did:")) {
        return new Response(
          JSON.stringify({ error: "subdomain and did are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Basic sanity: no dots in subdomain; we own the base domain already
      if (subdomain.includes(".")) {
        return new Response(
          JSON.stringify({ error: "subdomain must not contain dots" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const now = new Date().toISOString();

      // --- SUB_PREFIX: sub:<subdomain> -> { did, createdAt } ---
      const subKey = SUB_PREFIX + subdomain;
      const existingSubRaw = await env.anarchydids.get(subKey);

      if (existingSubRaw) {
        try {
          const existingSub = JSON.parse(existingSubRaw);
          if (existingSub.did && existingSub.did !== did) {
            return new Response(
              JSON.stringify({
                error: "handle already claimed by a different DID",
                existingDid: existingSub.did
              }),
              { status: 409, headers: { "Content-Type": "application/json" } }
            );
          }
        } catch {
          // if corrupt, we just overwrite below
        }
      }

      const subRecord = {
        did,
        createdAt: existingSubRaw ? undefined : now
      };

      await env.anarchydids.put(subKey, JSON.stringify(subRecord));

      // --- DID_PREFIX: did:<did> -> { createdAt, handles[] } ---
      const didKey = DID_PREFIX + did;
      const existingDidRaw = await env.anarchydids.get(didKey);

      let didRecord = {
        createdAt: now,
        handles: []
      };

      if (existingDidRaw) {
        try {
          const parsed = JSON.parse(existingDidRaw);
          if (parsed) {
            // keep original createdAt if present
            didRecord.createdAt = parsed.createdAt || now;

            // keep keyHash if this DID already has a secret key
            if (parsed.keyHash) {
              didRecord.keyHash = parsed.keyHash;
            }

            // normalize handles: accept strings *or* objects
            if (Array.isArray(parsed.handles)) {
              didRecord.handles = parsed.handles
                .map(h => {
                  if (typeof h === "string") {
                    return { sub: h, createdAt: now };
                  }
                  if (h && typeof h.sub === "string") {
                    return {
                      sub: h.sub,
                      createdAt: h.createdAt || parsed.createdAt || now
                    };
                  }
                  return null;
                })
                .filter(Boolean);
            }
          }
        } catch {
          // if corrupt, fall back to fresh record
        }
      }

      // Add this subdomain if it's not already present
      const already = didRecord.handles.some(h => h.sub === subdomain);
      if (!already) {
        didRecord.handles.push({ sub: subdomain, createdAt: now });
      }

      await env.anarchydids.put(didKey, JSON.stringify(didRecord));

      return new Response(
        JSON.stringify({
          ok: true,
          subdomain,
          did,
          subKey,
          didKey
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // --- Internal PDS hook: account deleted -> clean registry ---
    if (url.pathname === "/internal/pds/account-deleted" && request.method === "POST") {
      // Same bearer-token auth as /internal/pds/claim
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      if (!token || token !== env.PDS_BRIDGE_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const did = (payload.did || "").trim();
      if (!did) {
        return new Response(
          JSON.stringify({ error: "did is required" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      await deleteRegistryForDid(env, did);

      return new Response(
        JSON.stringify({ ok: true, did }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    // --- Internal PDS hook: directly set handle for a DID in registry ---
    if (url. pathname === "/internal/pds/set-handle" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      if (!token || token !== env.PDS_BRIDGE_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      const did = (payload.did || "").trim();
      const sub = (payload.sub || "").trim().toLowerCase();

      if (!did || !sub) {
        return new Response(
          JSON.stringify({ error: "did and sub are required" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" }
          }
        );
      }

      await setRegistryHandle(env, did, sub);

      return new Response(
        JSON.stringify({ ok: true, did, sub }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (isPdsHost && path === "/xrpc/com.atproto.server.deleteAccount" && method === "POST") {
      return handleProxyDeleteAccount(env, request);
    }
    
  // --- Intercept handle changes ---
  if (path === "/xrpc/com.atproto.identity.updateHandle") {
    return handleProxyUpdateHandle(env, request);
  }
  if (url.pathname === "/internal/debug/did" && request.method === "GET") {
    return handleDebugDid(request, env);
  }
  
// -------------------------------
// Global IP rate limit: 100 ops/hr
// (bypassed for admin + trusted IPs)
// -------------------------------
const clientIp = getClientIp(request);
const trusted = isTrustedIp(env, request);
const admin = isAdmin(request);

if (clientIp && !trusted && !admin) {
  const over = await incrementGuard(
    env,
    `${RATE_IP_PREFIX}${clientIp}:global:`,
    GLOBAL_IP_WINDOW_SECONDS,
    GLOBAL_IP_MAX_OPS
  );

  if (over) {
    return jsonResponse(
      {
        error:
          "This connection has sent a lot of traffic in a short time. Please slow down and try again later."
      },
      { status: 429 }
    );
  }
}

    // Public
    if (path === "/" && method === "GET") {
      const theme = pickPrideTheme();
      return htmlResponse(
        renderRootPage({ baseDomain: BASE_DOMAIN, version: VERSION, theme })
      );
    }
    // --- SIGNUP PAGE ---
    if (path === "/signup" && method === "GET") {
      return new Response(SIGNUP_HTML, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (path === "/register" && method === "POST") {
      return handleRegister(env, request);
    }
    // ---- MANAGE HANDLES
    if (path === "/m" && method === "GET") {
      const theme = pickPrideTheme();
      return htmlResponse(
        renderManagePage({ baseDomain: BASE_DOMAIN, version: VERSION, theme })
      );
    }
    
    if (path === "/m" && method === "POST") {
      return handleManage(env, request);
    }

    if (path === "/delete" && method === "POST") {
      return handleDelete(env, request);
    }

    if (path === "/.well-known/atproto-did" && method === "GET") {
      return handleWellKnown(env, request);
    }
    // --- ABOUT PAGE ---
    if (path === "/a" && method === "GET") {
      const theme = pickPrideTheme();
      return htmlResponse(
        renderAboutPage({
          baseDomain: BASE_DOMAIN,
          version: VERSION,
          theme
        })
      );
    }
    if (host === "pds.anarchy.lgbt" && path === "/xrpc/com.atproto.identity.updateHandle") {
      return handleProxyUpdateHandle(env, request);
    }
    
    if (url.pathname.startsWith("/xrpc/")) {
      return fetch("http://127.0.0.1:3002" + url.pathname, request);
    }
    
    // Admin
    if (path === "/gg" && method === "GET") {
      return handleAdminGet(env, request);
    }

    if (path === "/gg" && method === "POST") {
      return handleAdminPost(env, request);
    }

    if (path === "/gg/logout" && method === "GET") {
      return handleAdminLogout(env, request);
    }

    if (path === "/gg/dids" && method === "GET") {
      return handleAdminListDids(env, request);
    }
    if (path === "/gg/backfill-dids" && method === "POST") {
      return handleAdminBackfillDidRecords(env, request);
    }
    if (path === "/gg/backfill-dids" && method === "GET") {
      return handleAdminBackfillDidRecords(env, request);
    }

    if (path === "/gg/delete-handle" && method === "POST") {
      return handleAdminDeleteHandle(env, request);
    }

    if (path === "/gg/delete-did" && method === "POST") {
      return handleAdminDeleteAllForDid(env, request);
    }
    
    if (path === "/gg/config" && method === "GET") {
      return handleAdminConfigGet(env, request);
    }

    if (path === "/gg/config" && method === "POST") {
      return handleAdminConfigPost(env, request);
    }

    if (path === "/gg/activity" && method === "GET") {
      return handleAdminActivity(env, request);
    }
    if (path === "/gg/metrics" && method === "GET") {
      return handleAdminMetrics(env, request);
    }

    if (path === "/gg/resolve" && method === "POST") {
      return handleAdminResolve(env, request);
    }
    if (path === "/gg/export-config" && method === "GET") {
      return handleAdminExportConfig(env, request);
    }

    if (path === "/gg/import-config" && method === "POST") {
      return handleAdminImportConfig(env, request);
    }

    if (path === "/gg/export-registry" && method === "GET") {
      return handleAdminExportRegistry(env, request);
    }

    if (path === "/gg/import-registry" && method === "POST") {
      return handleAdminImportRegistry(env, request);
    }

    if (path === "/gg/assign-handle" && method === "POST") {
      return handleAdminAssignReserved(env, request);
    }
    
    return new Response("not found", { status: 404 });
  }
};
