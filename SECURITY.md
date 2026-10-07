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

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer via
the address on the GitHub profile. Please include:

1. the affected component (`server.js` verifier / classifier / dashboard),
2. a minimal reproducing request (headers only — no live keys),
3. the verdict you observed and the verdict you expected.

Issues that expose a path to a `valid` verdict without a correct signature over
the exact message are treated as critical.
