# Changelog

All notable changes to AEGIS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
advisory (the project is not published to npm).

## [2.0.0] — 2026-10-04

The v2 release moves AEGIS from a classified *mock* to a working observability
loop: real signatures are cryptographically verified, every classified request
appears in a live stream, and the dashboard tells the truth about which data is
live and which is simulated.

### Added — server

- **RFC 9421 HTTP Message Signatures verification** (`server.js`):
  - `Signature-Input` / `Signature` parsing (sf-Dictionary, quote- and
    balanced-parenthesis aware).
  - Signature-base construction per §2.5, including legacy `:component`
    normalization to `@component`.
  - Algorithm registry: Ed25519, RSA (PSS + v1.5), ECDSA P-256/P-384, HMAC-SHA256
    and their JOSE aliases.
  - JWKS keyring: `addVerificationKey`, `loadJwksFile`, and mtime-gated
    `ensureJwksFresh` reload (only on signed traffic — no polling).
  - **Fail-closed verdicts**: `valid` / `invalid` / `unresolved`. An unknown
    `kid` is never trusted; required components are `@method`, `@path`,
    `@authority`; signed-attributed requests must be fresher than ±120 s.
  - **SSRF guard**: the server never fetches `jku`/`jwk` URLs or anything else —
    keys come only from local files and explicit registration.
- Live counters by verdict (`counters.byVerdict`) surfaced in the SSE snapshot
  and JSON access-log output; `resetCounters()` for tests.
- Startup log now prints the loaded keyring (kid / alg / source).

### Added — dashboard

- **Live Event Stream** panel: filter chips (all / signed / known / shadow /
  tool / human), pause, JSON export, and a 60-row window over a 200-event ring
  buffer.
- **Request Rate** canvas: 60 × 10 s buckets, stacked by traffic kind, with a
  legend.
- **Shadow-traffic burst banner**: fires at ≥8 shadow requests in any 60 s
  window, clears with hysteresis below 4.
- **Header verdict badge** (`hdr-verdict`) driven by real verification results:
  `SIGNATURE VALID ✓`, `INVALID ✗`, `KEY NOT FOUND ?`.
- KPI row now shows live `valid · invalid · pending` counts; jwks stat labels
  renamed to their honest meanings (e.g. *Signed attempts · live*).
- Verification panel steps driven by actual verdicts instead of a fixed timer.
- Simulator feed is tagged `SIM` in the stream; captured traffic is tagged
  `LIVE`, so the two can never be confused.

### Added — tooling & docs

- `scripts/demo-traffic.js` — generates an ephemeral Ed25519 JWKS
  (`.demo-jwks.json`), then drives valid, wrong-key, ghost-key, shadow,
  known-agent, tool, and human traffic at the capture server. Deterministic
  demo expectation: **6 valid · 3 invalid · 3 unresolved**, burst banner trips.
- `scripts/screenshot.js` — CDP-over-WebSocket screenshot tool (no
  dependencies) used to refresh `docs/screenshots/`.
- `SECURITY.md` — threat model: fail-closed verdict table, SSRF guard, bounded
  replay honesty, log-tailing posture, and the reporting process.
- `README.md` rewritten for v2: demo quick start, four-suite test table, JWKS
  configuration, and a security section.

### Changed

- Test suite grew from 15 to **45 tests** across four suites
  (`server`, `verify`, `integration`, `build`); CI runs all four plus the
  generated-file sync check on Node 20/22/24.
- `index.html` remains fully generated — sources of truth are `styles.css` and
  `app.js`, merged by `build.js` with function replacers (byte-sync enforced by
  tests and CI).

### Verified

- Official RFC 9421 appendix B.2.6 Ed25519 vector passes end-to-end.
- Dashboard checked in a live browser: filter, pause, export, burst banner, and
  verdict badge all operate on captured traffic with a clean console.

## [1.0.0] — 2026-10-03

Initial release.

- Self-contained AEGIS dashboard (9 sections) generated from
  `styles.css` + `app.js` by `build.js`.
- Zero-dependency capture server: request classification (signed / known agent /
  shadow / tool / human), SSE stream, log tailing, nginx + JSON access-log
  parsing.
- Classification contract and build-sync tests (15 tests), CI matrix,
  screenshots, README, MIT license, contributing guide.
