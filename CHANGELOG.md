# Changelog

All notable changes to AEGIS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
advisory (the project is not published to npm).

## [Unreleased]

### Added

- **`scripts/demo-traffic.js` now verifies its own scrape**: it captures
  `GET /metrics` before firing, diffs it after, and requires the delta to
  cover every verdict and traffic kind it sent — a shortfall prints `FAIL`
  per counter. Extra delta (e.g. an open dashboard) is tolerated and noted.

### Changed

- `package.json` version bumped from 1.0.0 to **3.0.0** to match this
  changelog (the package is advisory — AEGIS is not published to npm).
- `CONTRIBUTING.md` test list now documents all five suites — the missing
  `tests/jwks.test.js` bullet was added and the `integration`/`build` bullets
  refreshed for `/metrics` and the default-deny/inspector assertions.

### Security

- `SECURITY.md` gained **§6** documenting the `/metrics` posture:
  self-excluding telemetry path, bounded low-cardinality labels (no paths,
  IPs, headers, or signature material ever become labels; JWKS results count
  outcomes, not origin URLs), and the no-authentication stance — binding
  `HOST=0.0.0.0` publishes dashboard and metrics together, so front it with a
  proxy or network policy.

## [3.0.0] — 2026-10-07

The v3 release makes AEGIS deployable and integrable: standard metrics for
existing observability stacks, infrastructure-as-code, a real out-of-band key
resolver for rotating agents, and an interactive schema inspector for the
WebMCP ledger.

### Added — server

- **`GET /metrics`** — Prometheus text exposition (0.0.4): request counts by
  kind, verification pass/fail ratios by verdict, per-agent counts, derived
  signal counters, a request-duration **histogram** (12 buckets, recorded from
  real measured milliseconds in `emit()`), events-per-minute, open SSE
  clients, counter-epoch uptime, and JWKS fetch results. The scrape path is in
  `TELEMETRY_PATHS`, so scrapes never inflate the numbers they report.
- **Background JWKS resolver** — the allowlisted remote path is now an
  asynchronous key-fetcher:
  - per-origin queue with dedupe: a burst of unknown keyids opens one socket
    and never blocks a live request;
  - **exponential backoff** per origin (1 s base → 5 min cap, ±20 % jitter)
    with stale-if-error reuse of the last good document;
  - **TLS SPKI pinning** (`JWKS_PINS`, per-origin, multiple pins for rollover,
    base64 or hex) verified on the live peer certificate before any body byte
    is accepted — fail closed on mismatch, WebPKI unchanged when unpinned;
  - transport moved from `fetch()` to stdlib `https` with a no-reuse agent
    (full handshake every time so the peer cert is always inspectable),
    3xx refusal, mid-stream 64 KB cap, hard 3 s timeout, optional
    `JWKS_CA_FILE` operator CA;
  - periodic refresher re-queues cached origins past half their TTL (unref'd).
  - Default-deny allowlist and private-host refusals are unchanged and still
    gate before any socket work.
- `HOST` is now configurable (`0.0.0.0` in containers; default stays
  loopback-only for safe local runs).

### Added — dashboard

- **WebMCP schema inspector**: clicking (or Enter/Space on) any ledger row
  opens a dialog with the tool's full request JSON-Schema beside the actual
  payload and a **field-by-field payload diff** (expected vs actual,
  match/violation verdict). Draft 2020-12 schemas are declared for all eight
  registry tools; 422 rows drop a required field so the diff agrees with the
  Result column; live rows get an inferred schema, labeled as such. Rows are
  keyboard-operable, the dialog is `aria-modal` with focus management, and
  Esc / backdrop click dismiss it.

### Added — deployment

- **Multi-stage `Dockerfile`** — build stage bundles the dashboard and runs the
  full test suite (a broken image cannot be produced); runtime stage is a
  non-root minimal Node image with a `HEALTHCHECK`.
- **`docker-compose.yml`** — read-only rootfs, dropped capabilities,
  no-new-privileges, healthcheck.
- **`deploy/k8s/`** — Deployment (liveness `/api/health`, readiness
  `/api/snapshot`, both telemetry paths so probes never pollute metrics),
  Service, ConfigMap for `JWKS_ALLOWLIST`, kustomize-ready; non-root,
  read-only rootfs, seccomp `RuntimeDefault`, resource requests/limits.

### Changed

- Test suite grew from 48 to **66 tests** across five suites (new
  `tests/jwks.test.js`, plus metrics and inspector tests); CI runs all five.
- `SECURITY.md` §2 rewritten for the new fetcher controls (backoff, pinning,
  CA, background queue) with the honest statement of what is and is not
  pinned.

### Verified

- Docker image builds with 66/66 tests inside the build stage; the container
  reaches `healthy` while serving `/api/health`, `/api/snapshot`, and
  `/metrics`; compose stack comes up healthy; all three Kubernetes manifests
  pass `kubeconform -strict`.
- Inspector checked in a live browser: valid rows report `SCHEMA VALID`, 422
  rows flag the missing field, focus round-trips, console clean.

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
