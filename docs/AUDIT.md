# AEGIS — Audit, Ratings & Production-Readiness Upgrade

*Audited 2026-10-09 at commit `92d769c`, working tree clean.*

**Baseline (recorded before any change):** `npm test` → **66/66 pass, exit 0**;
`node build.js` + `git diff --exit-code` → **SYNC_OK**; `node --check server.js`
→ OK. No pre-existing failures.

**File note:** the working repository contains `app.js` and `build.js` (not
`app_3.js` / `build_3.js` — those files do not exist here; nothing was invented
for them). All references below use the real names: `app.js`, `build.js`,
`index.html` (partly source markup, partly generated `<style>`/`<script>`).

## 1. Baseline ratings (before this upgrade)

| Domain | Score | Evidence · weaknesses · confidence |
| --- | --- | --- |
| UI/UX & visual design | **7.5/10** | Polished dark ops-center theme; `aria-modal` dialog with focus trap + Esc (browser-verified); LIVE/SIM feed tags; 3 `@media` breakpoints. Weak: no `prefers-reduced-motion`, clock shows mixed timezones, some panels unlabeled in pure-SIM mode. Confidence: high (browser + CSS inspection). |
| Frontend functionality | **7/10** | SSE live stream, filters, pause, JSON export, burst detector, WebMCP inspector all verified working in-browser. Weak: stream does not repopulate from history on reload (counters do), fabricated trend lines under live KPIs, sim/live value mixing. Confidence: high. |
| Backend architecture & reliability | **7/10** | Single-file but cleanly sectioned, zero-dependency, telemetry paths excluded from their own counters, health/snapshot endpoints, bounded DOM/row buffers. Weak: no auth, no ingestion rate limit, in-memory counters only, `LOG_PATH` tail trusts the file. Confidence: high. |
| HTTP Message Signatures / crypto | **8.5/10** | RFC 9421 Appendix B.2.6 vector tested end-to-end; Ed25519/RSA-PSS/PKCS1/ECDSA/HMAC; fail-closed verdicts; ±120 s freshness; coverage policy; deeply tested (verify + jwks suites). Weak: no nonce store (documented); **UI claims "Verify Content-Digest" but the server never verifies it** (honesty bug). Confidence: high. |
| Data accuracy & live telemetry | **5.5/10** | Counters/verdicts are real and test-locked; scrape accounting proven. Weak (found this audit): clock mixes UTC date with local time labeled "UTC"; `applySnapshot` writes `1247 + live`-style mixes into SIM KPIs; random walk ticks values that live snapshots then overwrite (visible jumps); fabricated `▲ x%` trend strings; untested reconnect/dup paths. Confidence: high (source-level). |
| Security & privacy | **6/10** | Strong JWKS/SSRF posture (default-deny allowlist, SPKI pins, backoff, size/time/rate caps — heavily tested); `escHtml`/textContent DOM safety; fail-closed verdicts. Weak: **no authentication anywhere** (dashboard, SSE, snapshot, `/metrics`) even when bound to `0.0.0.0`; **unbounded `byPath` map** (attacker-controlled keys → memory + snapshot payload growth); no security headers; no ingestion rate limit. Confidence: high. |
| Automated testing & QA | **8/10** | 66 tests / five suites incl. RFC vector, SSRF guards, JWKS transport against a live local HTTPS server, build byte-sync, CI matrix 20/22/24, Docker build gate, worktree-verified history. Weak: no SSE reconnect/dup tests, no auth tests (didn't exist), no detection-quality corpus, validator tested only via bundle extraction. Confidence: high. |
| Performance & scalability | **6.5/10** | O(1) counters, cumulative histogram, bounded ring buffers, single JSON.stringify per broadcast. Weak: unbounded `byPath`, no measured burst/soak numbers, single-process memory-only state. Confidence: medium (reasoned, not load-tested). |
| Deployment readiness | **7.5/10** | Multi-stage Dockerfile with test gate + HEALTHCHECK, hardened compose, k8s manifests with probes (kubeconform 3/3), CI. Weak: no auth in any manifest; compose lacks a keyring mount for signed verification; GitHub badge slug unverifiable (no remote). Confidence: high. |
| Documentation & maintainability | **8/10** | README/SECURITY/CONTRIBUTING/CHANGELOG are detailed and honest; src/ ↔ index.html byte-sync enforced by tests. Weak: no auth/OTLP docs yet, no troubleshooting section, this audit was missing. Confidence: high. |

**Overall project quality: 7/10.** **Production-readiness: 5.5/10** — the
verifier and test culture are strong, but an unauthenticated console on
`0.0.0.0` plus the live-vs-sim integrity bugs keep it out of production.

## 2. Prioritized pending-work list

### Critical
- **C1 · Live-vs-sim integrity** — fix clock timezone agreement; stop
  `applySnapshot` from mixing hardcoded baselines into SIM KPIs; stop random
  generators from ticking values that live snapshots own; remove/clear
  fabricated `▲%` trend lines when live; label SIM panels in pure-SIM mode;
  label the ticker; dedupe/reconnect-safe counters; empty/zero-rate chart
  handling (already guarded by `max(4,…)` — verified).
- **C2 · Authentication & RBAC** — optional HTTP Basic auth
  (`AEGIS_AUTH_USERS=user:pass:role,…`) covering dashboard, static, snapshot,
  SSE, and `/metrics`, with roles `admin` / `viewer` / `metrics`;
  `/api/health` stays open for probes; constant-time comparison; 401 +
  `WWW-Authenticate`; safe default unchanged (loopback), documented for
  remote deployment.
- **C3 · Unbounded `byPath` cardinality** — cap the path map (top-N by count)
  so attacker-chosen paths cannot grow memory or snapshot payloads.

### High
- **H1 · Schema validator completeness** — recursive nested objects, `items`
  array validation, `anyOf` / `allOf` / `oneOf`, with path-qualified findings.
- **H2 · OTLP/HTTP telemetry exporter** — optional push of request spans to an
  OTLP/HTTP JSON endpoint (`OTLP_ENDPOINT`), bounded async queue, counted in
  `/metrics`; gRPC explicitly deferred (would break zero-dependency).
- **H3 · Honesty fix** — UI claims "Verify Content-Digest" but the server
  never does; relabel the verification step to what actually happens.
- **H4 · SSE regression tests** — reconnect delivers an idempotent snapshot
  (no double counting), pause/filter/export contract.

### Medium
- **M1 · Sim-engine extraction** — move the simulator into a dedicated module
  excluded from production builds (bundle-size + leakage win; needs a build
  flag and test updates).
- **M2 · Detection-quality corpus** — labeled fixtures (legit bots / signed /
  humans / automation) with measured false-positive/negative rates.
- **M3 · `prefers-reduced-motion` + a11y pass**; responsive check on the 3
  existing breakpoints.
- **M4 · Burst/soak measurement** — record throughput, memory, and SSE
  latency under load.

### Low
- **L1 · Build-tooling migration** — esbuild/Vite rejected for now: it adds a
  dependency and the corruption class it would prevent is already locked by
  function replacers + byte-sync tests (`build.test.js`). Revisit if the
  module count grows past ~30.
- **L2 · Compose keyring mount / demo profile**; **L3 · OTLP gRPC** (needs
  deps); **L4 · security headers** (CSP/frame) once auth lands.

## 3. What was implemented (highest-impact issues)

| Commit | Change |
| --- | --- |
| `aeeada3` | **C1** live-vs-sim integrity: clock zone fix, snapshot/sim separation, fabricated trends removed, ledger seizure + SIM labeling, SSE dedupe, Content-Digest honesty |
| `7f8129d` | **C3** `byPath` cardinality + key-length cap (flood + reconnect tests) |
| `8f545fb` | **C2** HTTP Basic auth + RBAC (`AEGIS_AUTH_USERS`), probe exemption, `aegis_auth_failures_total` |
| `cd9f7ae` | **H1** recursive schema validator (nested/arrays/anyOf/allOf/oneOf/const) |
| `b2af8f7` | **H2** OTLP/HTTP span exporter (`OTLP_ENDPOINT`), bounded queue, `aegis_otlp_exports_total` |
| *(this docs commit)* | README hardening + troubleshooting, SECURITY §7, CHANGELOG, this audit |

## 4. Verification (all executed, exit codes captured)

- `npm test` → **75/75 pass, exit 0** (baseline was 66/66 — nine new
  regression tests, one per fixed defect class; no test skipped).
- `node build.js` + sync test → generated files in sync; `node --check`
  on server and scripts → OK.
- `docker build` → build-stage test gate ran **75/75 inside the image**,
  image rebuilt (`BUILD_EXIT=0`).
- Live container auth matrix: health 200 (no creds), dashboard 401 →
  200 (admin), `/metrics` 200 (metrics role) and 403 (metrics role on
  dashboard), `WWW-Authenticate: Basic realm="AEGIS"` present, boot log
  prints `[auth] enabled — 2 user(s), roles: admin, metrics`.
- OTLP verified against a real local collector (payload shape, `/v1/traces`,
  span fields) and a dead endpoint (failures counted, health stays green).
- `preview_screenshot` could not composite frames this session — the
  rendered-state checks were done through the DOM/accessibility tree and
  build markers instead; no pixel screenshot was taken.

## 5. Final ratings (after implementation)

| Domain | Before | After | Evidence for the change · what still caps it |
| --- | --- | --- | --- |
| UI/UX & visual design | 7.5 | **8** | Honest clock, `· SIM` labels everywhere, no fake trends, honest step labels. Still: no `prefers-reduced-motion`, 3 breakpoints only, no pixel-verified pass this session. |
| Frontend functionality | 7 | **8** | Sim/live separation, dedupe, seized ledgers, dialog/a11y kept. Still: stream table fills only with post-load events (documented in troubleshooting, not backfilled). |
| Backend architecture & reliability | 7 | **7.5** | Auth, OTLP, bounded path map, fail-closed config. Still: single-file, in-memory counters, no ingestion rate limit. |
| HTTP Message Signatures / crypto | 8.5 | **8.5** | Untouched (already strongest); UI no longer overclaims digest verification. Still: no nonce store (documented §3). |
| Data accuracy & live telemetry | 5.5 | **8** | Every mixing/labeling defect from the audit fixed and locked by tests; reconnect idempotence tested. Still: no long-run soak evidence. |
| Security & privacy | 6 | **7.5** | Auth+RBAC (fail-closed, constant-time), DoS cap on `byPath`, §7 documented. Still: no TLS (proxy required), no rate limiting, no CSP/security headers. |
| Automated testing & QA | 8 | **8.5** | 78 tests; first coverage of auth, OTLP, floods, reconnect, integrity markers, dashboard-honesty gate, source-leak guard, no-CORS regression. Still: validator tested via bundle extraction; no detection corpus. |
| Performance & scalability | 6.5 | **7** | Path map and OTLP queue bounded; histograms O(1). Still: throughput/memory never load-tested (M4 open). |
| Deployment readiness | 7.5 | **8** | Image gate runs 75/75; auth verified live in-container; probes unchanged. Still: compose lacks a keyring mount; badge slug unverifiable (no remote). |
| Documentation & maintainability | 8 | **8.5** | SECURITY §7, README hardening + troubleshooting, CHANGELOG, this audit. Still: screenshots predate the inspector modal. |

**Overall project quality: 7 → 7.5/10.**
**Production-readiness: 5.5 → 7/10** — the two hard blockers (no auth,
unbounded attacker-controlled state) are closed; the remaining gap to 8+
is operational evidence: TLS/reverse-proxy in front, ingestion rate
limiting, a load report, and the detection-quality corpus.

## 6. Unresolved risks / deliberately deferred

- **M1** sim-engine extraction into a build-excluded module — structural
  refactor of 16 modules with byte-sync tests; integrity is now enforced
  by labels + gating, so leakage risk is low; still worth doing.
- **M2** labeled detection corpus with FP/FN rates — none exists; every
  classifier claim rests on unit contracts, not measured quality.
- **M3** `prefers-reduced-motion` + deeper a11y/responsive pass.
- **M4** burst/soak numbers (throughput, memory, SSE latency) — untested.
- **L1** compose keyring mount/demo profile · **L2** esbuild/Vite migration
  (rejected: adds a dependency; the corruption class is already locked by
  function replacers + byte-sync tests) · **L3** OTLP gRPC (needs deps) ·
  **L4** CSP/frame security headers · README badge slug (no git remote to
  verify `anushms/aegis`).
- Manual configuration operators must do: set `AEGIS_AUTH_USERS` for any
  non-loopback bind, terminate TLS at a proxy, and set `OTLP_ENDPOINT`
  only to collectors they trust.
