# Security — AEGIS

## Scope

AEGIS is an observability component: it classifies and verifies traffic, it does not
enforce access control on your origin. Its own security properties still matter,
because a verifier that can be tricked is worse than no verifier.

## Threat model

### 1. Signature verification fails closed

Every outcome that is not a successful public-key check is untrusted:

| Verdict | Meaning |
| --- | --- |
| `valid` | The signature cryptographically verified against a key in the local keyring, the covered components include `@method`, `@path`, and `@authority`, and `created`/`expires` are inside the ±120 s freshness window. |
| `invalid` | Parse failure, bad signature bytes, wrong key, insufficient component coverage, or an out-of-window timestamp. |
| `unresolved` | The `keyid` is not in the local keyring, or the algorithm is unsupported. **Never counted as trusted.** |

There is no "probably valid" state. The dashboard shows the exact reason string.

### 2. Outbound key fetches are default-deny (SSRF guard)

RFC 9421 signatures carry a `keyid` parameter, and Web Bot Auth adds a
`Signature-Agent` header — both can be arbitrary URLs. Dereferencing them from a
capture server would be a server-side request forgery primitive (cloud metadata
endpoints, internal admin panels).

**AEGIS never fetches a URL taken from a request header.** Keys are loaded from:

- `JWKS_PATH` — a local file you control, reloaded on mtime change; or
- `addVerificationKey(jwk)` — programmatic registration (tests, embedded use).

Remote JWKS resolution exists, but it is **operator-configured, not
request-controlled**: it runs only when you set `JWKS_ALLOWLIST`, and every
fetch must pass all of the following or it is refused before any socket opens:

| Control | Behavior |
| --- | --- |
| Allowlist | exact `origin` match against `JWKS_ALLOWLIST` (default: empty → deny everything) |
| Scheme | `https:` only |
| Host | loopback, RFC1918, link-local (incl. `169.254.169.254`), CGNAT, `.local`/`.internal` and bare IPv6 refused |
| Redirects | 3xx responses are refused, never followed |
| Size / time | 64 KB cap enforced mid-stream, 3 s hard timeout |
| Rate | 6 fetches per origin per minute, then reuse-or-deny |
| Cache | 10-minute TTL so keys are not re-fetched per request |
| Backoff | failures back off exponentially per origin (1 s → 5 min, ±20 % jitter); during backoff the last good document is served stale, or `null` if there is none |
| Pinning | optional `JWKS_PINS` (per-origin SPKI pins, base64 or hex) verified against the live TLS peer certificate **before any body byte is accepted** — a mismatch fails closed; unpinned origins keep standard WebPKI validation |
| CA trust | optional `JWKS_CA_FILE` adds an operator CA bundle for private-PKI origins; never request-controlled |

The allowlist is configuration the operator writes; a remote party cannot add
to it by sending headers. Fetches run on a **background queue** deduplicated
per origin — a burst of unknown `keyid`s opens one socket and never blocks a
live request — and an unref'd refresher re-queues cached origins past half
their TTL so keys rotate without traffic. Verification itself stays
synchronous: a missing key stays `unresolved` for that request and the
keyring warms for later ones.

The TLS transport uses stdlib `https` with a no-reuse agent, so every fetch
performs a full handshake and the peer certificate is always inspectable
(session resumption could otherwise hide it from pinning).

`tests/build.test.js` asserts the verification path is gated on
`jwksAllowlist()` and exercises every refusal above (empty allowlist, loopback,
`http:`, suffix-lookalike origins); `tests/jwks.test.js` covers backoff math,
pin parsing and fail-closed verification, queue gating and dedupe, and the
live transport (pin match/mismatch, redirects, size cap, timeout) against a
local HTTPS server. The guard cannot regress silently.

### 3. Replay resistance is bounded, and honestly labeled

AEGIS checks `created`/`expires` against a ±120 s window when present. It does not
maintain a nonce store, so a captured signature can be replayed inside that window.
Treat AEGIS as a *detector and classifier*; replay prevention belongs at the
enforcement point. This limitation is stated rather than hidden.

### 4. Verification is local and offline

Verification uses only `node:crypto` and the local keyring. The verifier never
executes content from requests, never evaluates headers, and renders all captured
values through HTML-escaping (`escHtml`) in the dashboard.

### 5. Log tailing

`LOG_PATH` tails a file you point at. Lines are parsed defensively — malformed
lines are ignored, never thrown (covered by tests). Log-sourced events are
classified without the live-socket browser-claim heuristic, because access logs do
not record the headers it inspects.

### 6. `/metrics` is telemetry, not an API

`GET /metrics` serves Prometheus text exposition of aggregate counters:
events by kind, verification outcomes by verdict, per-agent counts, derived
signal totals, a request-duration histogram, and JWKS fetch results. Its
posture:

- **Self-excluding** — the scrape path is in `TELEMETRY_PATHS`, so fetching
  `/metrics` (or health/snapshot probes) never increments the counters it
  reports; a scraper cannot inflate what it observes.
- **No captured content** — labels are bounded enums produced by the
  classifier (`kind`, `verdict`, `agent`, `signal`). Paths, IPs, headers,
  bodies, and signature material are never labels, so scraping cannot
  exfiltrate individual captured requests. JWKS results are counted by
  outcome only, never by origin URL.
- **No authentication, like the whole console** — the server binds
  `127.0.0.1` by default. Publishing it (`HOST=0.0.0.0`, containers, k8s
  Service) publishes the dashboard and metrics together: anyone who can reach
  the port sees traffic shape and verdict pass/fail ratios. Place it behind
  your reverse proxy, network policy, or scraper ACL.

`tests/integration.test.js` locks the exposition format and asserts a scrape
does not bump event counters.

### 7. Access control and bounded telemetry state

**Authentication (optional, HTTP Basic).** Setting
`AEGIS_AUTH_USERS="user:pass:role,…"` requires login on every route except
`/api/health` (container and Kubernetes probes must stay unauthenticated and
reveal only liveness, not telemetry). Roles:

| Role | May access |
| --- | --- |
| `admin` | dashboard, static assets, `/api/snapshot`, `/events`, `/metrics` |
| `viewer` | dashboard, static assets, `/api/snapshot`, `/events` |
| `metrics` | `/metrics` only |

Properties: credentials are compared as constant-time SHA-256 digests;
entries with an empty or unknown role are **dropped** and a configuration
with zero parseable users **denies everything** (a typo fails closed, never
open); refusals are counted in `aegis_auth_failures_total{result=…}` so brute
force is observable. The default (variable unset) is open — acceptable only
on the default `127.0.0.1` bind. **Any non-loopback deployment must set
`AEGIS_AUTH_USERS` or front the server with an authenticating proxy.**

**Bounded telemetry state.** `counters.byPath` keys are attacker-controlled;
the map is capped (200 entries, 200-char keys, lowest-count eviction) so a
unique-path flood cannot grow memory or `/api/snapshot` payloads without
bound (`tests/integration.test.js` floods it with 251 distinct paths).
Prometheus labels remain bounded enums (kind, verdict, agent, signal,
auth/OTLP result) — no path, header, IP or signature material ever becomes a
label.

**OTLP export (optional).** `OTLP_ENDPOINT` is operator configuration, never
request-controlled; it is validated to `http(s)://`, redirects are not
followed, the queue is bounded (1024 spans, drop-oldest), and export failures
are counted (`aegis_otlp_exports_total`) without ever disturbing capture.
Spans carry method, path, user agent, client IP, kind and verdict — treat the
collector as telemetry-equivalent to this server's own logs.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer via
the address on the GitHub profile. Please include:

1. the affected component (`server.js` verifier / classifier / dashboard),
2. a minimal reproducing request (headers only — no live keys),
3. the verdict you observed and the verdict you expected.

Issues that expose a path to a `valid` verdict without a correct signature over
the exact message are treated as critical.
