<!-- docs/assets/aegis-avatar.svg -->
<p align="center">
  <img src="docs/assets/aegis-avatar.svg" width="132" alt="AEGIS logo" />
</p>

<h1 align="center">AEGIS</h1>

<p align="center">
  <strong>Global AI Agent Observability Console</strong><br/>
  Classify every request that reaches your edge — cryptographically <em>verify</em> signed agents,<br/>
  catch headless shadow traffic, and watch it all live.
</p>

<p align="center">
  <a href="https://github.com/anushms/aegis/actions/workflows/ci.yml"><img src="https://github.com/anushms/aegis/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/tests-45%20passing-success.svg" alt="45 tests passing" />
</p>

---

AEGIS is a **zero-dependency** observability stack for the agent-filled web:

- **A capture server** that classifies every inbound request — `signed`, `known` crawler,
  `shadow` (headless/evasive), `tool` (scripted), or `human` — and **actually verifies
  RFC 9421 HTTP Message Signatures** cryptographically against a local JWKS keyring.
  Verdicts are literal: `VALID`, `INVALID`, or `UNRESOLVED`. Nothing is called verified
  that has not been verified.
- **A live console** that renders the stream over SSE: event table with filters and JSON
  export, a 10-minute rate chart, a shadow-burst detector, the Web Bot Auth verification
  loop with the real signature verdict, and clear `LIVE` / `SIM` tags on every panel.

The verification core is spec-tested against the **RFC 9421 Appendix B.2.6 Ed25519 test
vector** — if that vector verifies, the signature-base reconstruction matches the
specification byte-for-byte.

## Screenshots

| Live console — burst banner, KPIs, event stream | Signature verification — real verdict |
| --- | --- |
| ![Overview](docs/screenshots/overview.png) | ![Verification](docs/screenshots/verification.png) |

| Shadow-agent detection — matrix and live feed |
| --- |
| ![Shadow detection](docs/screenshots/shadow-detection.png) |

## What it does

- **Real signature verification (RFC 9421).** Parses the `Signature-Input` /
  `Signature` structured fields, rebuilds the signature base (`"@method": …` lines,
  quoted component identifiers, `@signature-params`), and verifies Ed25519, RSA-PSS,
  RSASSA-PKCS1, ECDSA (P-256/P-384) and HMAC-SHA256 signatures. Enforces a Web Bot Auth
  profile: `@method`, `@path`, and `@authority` must be covered, with a ±120 s freshness
  window. Keys load from `JWKS_PATH` (mtime-reloaded) or programmatically — **keyid URLs
  are never dereferenced** (SSRF guard, see [SECURITY.md](SECURITY.md)).
- **Request classification** — every request falls into exactly one kind: `signed`,
  `known` (21 published agent UAs — GPTBot, ClaudeBot, PerplexityBot, Google-Extended,
  CCBot, Bytespider, …), `shadow` (headless/automation engines and browser claims
  without client hints, with confidence scores), `tool` (curl, python-requests, …), or
  `human`.
- **Live event stream** — filterable table (kind chips, pause, JSON export), real
  verdict counts in the KPI strip, a stacked rate chart in 10-second buckets, and a
  shadow-burst banner (≥ 8 stealth requests / 60 s, hysteresis on clear).
- **SSE delivery** — `GET /events` streams classified events; new clients hydrate from
  a snapshot so counters never restart at zero.
- **Access-log tailing** — point `LOG_PATH` at an nginx combined-format or JSON access
  log; signed JSON lines are verified too. No proxy required.

## Quick start

**Requirements:** Node.js 20 or newer. No `npm install` — there are no dependencies.

```bash
git clone https://github.com/anushms/aegis.git
cd aegis
JWKS_PATH=.demo-jwks.json node server.js      # or: npm start
```

Open <http://127.0.0.1:8788>. In a second terminal, generate a realistic mix —
including honestly signed requests (the script creates an ephemeral Ed25519 key,
publishes the public half for the server to load, then signs with it):

```bash
node scripts/demo-traffic.js
```

Expect **6 valid, 3 invalid, 3 unresolved** signature verdicts, 10 shadow requests, and
the shadow-burst banner within seconds.

**Configuration:**

| Variable    | Default      | Purpose                                    |
| ----------- | ------------ | ------------------------------------------ |
| `PORT`      | `8788`       | HTTP listen port                           |
| `JWKS_PATH` | *(disabled)* | JWKS file for signature verification (reloaded on change) |
| `LOG_PATH`  | *(disabled)* | Access log to tail (nginx or JSON lines)   |
| `HOST`      | `127.0.0.1`  | Bind address                               |

**Dashboard only:** open `index.html` directly in a browser — it is fully
self-contained and runs from its built-in simulation engine (`file://` pages never
attempt a live connection).

## Testing

```bash
npm test        # 45 tests, four suites
```

| Suite | Covers |
| --- | --- |
| `tests/verify.test.js` | **RFC 9421 Appendix B.2.6 test vector**, signature-base policy (coverage, freshness, keyring, algorithms), parser edge cases |
| `tests/integration.test.js` | the real HTTP server on an ephemeral port: classification, verdict counters, snapshot shape, SSE hydration + broadcast |
| `tests/server.test.js` | classification contract (known UA matrix, shadow confidence, tool-vs-shadow regressions), nginx/JSON log parsing |
| `tests/build.test.js` | `index.html` byte-synced to its sources, self-contained page, honesty markers, no outbound requests in the verifier |

CI runs the suite on Node 20, 22, and 24, syntax-checks every source file, and fails if
a committed `index.html` drifts from `styles.css` / `app.js`.

## Project structure

```
index.html            generated, self-contained dashboard (the deliverable)
├── styles.css        theme + layout source
├── app.js            telemetry engine + live-capture module source
└── build.js          merge step (node build.js)
server.js             capture server: classifier, RFC 9421 verifier, SSE, log tail
tests/                four node:test suites (npm test)
scripts/demo-traffic.js   signed + shadow + bot traffic generator for demos
scripts/screenshot.js     headless-Chrome captures for the screenshots above
docs/                 screenshots, logo
SECURITY.md           threat model (SSRF guard, verdict semantics, reporting)
```

**Editing workflow:** change `styles.css` / `app.js`, run `npm run build`, commit both
sources and the regenerated `index.html`. CI verifies the three stay consistent.

## Honest data labeling

The console distinguishes what it measures from what it models:

- `LIVE` — real requests captured by `server.js`: KPIs 1–3, the event stream, the rate
  chart, the shadow feed, and every signature verdict. `VALID` means a public-key
  verification actually succeeded against the local keyring; `UNRESOLVED` means the key
  is unknown — never presented as trusted.
- `SIM` — simulation of research findings and market forecasts (GEO citation economics,
  Pay-Per-Crawl revenue, IPI payload rates, TrjAD anomaly volume, the registry table).
  Each simulated panel is tagged in the UI.

## Security

Signature verification is designed to fail closed: unknown keys are `UNRESOLVED`,
never trusted; insufficient component coverage or an expired window is `INVALID`.
The server never fetches URLs found in `keyid` or `Signature-Agent` headers.
See [SECURITY.md](SECURITY.md) for the full threat model and reporting process.

## References

- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [Web Bot Auth](https://web-bot-auth.github.io/)
- [RFC 9309 — Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
- [GPTBot](https://openai.com/gptbot/)
- [Google-Extended](https://developers.google.com/search/docs/crawling-indexing/google-extended)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
build/test workflow, the `String.replace` pitfall that will silently corrupt the
generated dashboard, and commit-message conventions.

## License

[MIT](LICENSE) © anushms
