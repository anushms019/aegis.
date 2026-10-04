<!-- docs/assets/aegis-avatar.svg -->
<p align="center">
  <img src="docs/assets/aegis-avatar.svg" width="132" alt="AEGIS logo" />
</p>

<h1 align="center">AEGIS</h1>

<p align="center">
  <strong>Global AI Agent Observability Console</strong><br/>
  Classify every request that reaches your edge — cryptographically signed agents,<br/>
  known crawlers, headless shadow traffic, scripted tools, and humans.
</p>

<p align="center">
  <a href="https://github.com/anushms/aegis/actions/workflows/ci.yml"><img src="https://github.com/anushms/aegis/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/tests-15%20passing-success.svg" alt="15 tests passing" />
</p>

---

AEGIS is a **zero-dependency** observability stack for the agent-filled web: a
capture server that classifies inbound traffic in real time — Web Bot Auth
signatures (RFC 9421), known agent UAs, stealth/headless shadow behavior,
scripted tooling, ordinary humans — and a live console that renders the
verification loop, anomaly charts, and threat intelligence as events arrive.

It is both a working classifier you can put behind a real access log and a
self-contained briefing console for the emerging agent economy (Web Bot Auth,
GEO, WebMCP, Pay-Per-Crawl, prompt-injection defense).

## Screenshots

| Live console — KPIs and global ingress | Web Bot Auth verification loop |
| --- | --- |
| ![Overview](docs/screenshots/overview.png) | ![Verification](docs/screenshots/verification.png) |

| Shadow-agent detection — matrix and live feed |
| --- |
| ![Shadow detection](docs/screenshots/shadow-detection.png) |

The first three KPIs and the header inspector are driven by **real captured
requests** when the server is running (marked `LIVE`); economic and
research-forecast panels are clearly marked `SIM`. See
[Honest data labeling](#honest-data-labeling).

## What it does

- **Request classification** — every request falls into exactly one kind:
  `signed` (RFC 9421 `Signature` + `Signature-Input` headers present),
  `known` (21 published agent UAs — GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended, CCBot, Bytespider, …), `shadow` (headless/automation
  browsers and browser claims without client hints, with a confidence score),
  `tool` (curl, python-requests, other scripted clients), or `human`.
- **Live capture over SSE** — `GET /events` streams classified events to the
  dashboard; new clients are hydrated with a snapshot so KPIs never start at
  zero.
- **Access-log tailing** — point `LOG_PATH` at an nginx combined-format or
  JSON access log and AEGIS classifies lines as they are appended. No proxy
  required.
- **Verification loop** — parses captured `Signature` / `Signature-Input` /
  `Signature-Agent` headers, shows them verbatim, and reports an honest
  verdict (headers present vs. keys pending — it never claims to have
  cryptographically verified a signature it has not verified).
- **Detection analytics** — evasion matrix, UA-entropy and isTrusted charts,
  trajectory (TrjAD-style) stream, citation-economy and threat-intel panels.

## Quick start

**Requirements:** Node.js 20 or newer. No `npm install` — there are no
dependencies.

```bash
git clone https://github.com/anushms/aegis.git
cd aegis
node server.js            # or: npm start
```

Open <http://127.0.0.1:8788>. The dashboard attaches to the capture stream
immediately; generate traffic in another terminal to watch it classify:

```bash
curl http://127.0.0.1:8788/index.html
curl -A "GPTBot/1.2" http://127.0.0.1:8788/index.html
```

**Tail an existing access log instead:**

```bash
LOG_PATH=/var/log/nginx/access.log node server.js
```

**Configuration:**

| Variable    | Default            | Purpose                                  |
| ----------- | ------------------ | ---------------------------------------- |
| `PORT`      | `8788`             | HTTP listen port                         |
| `LOG_PATH`  | *(disabled)*       | Access log to tail (nginx or JSON lines) |
| `HOST`      | `127.0.0.1`        | Bind address                             |

**Dashboard only:** open `index.html` directly in a browser — it is fully
self-contained and runs from its built-in simulation engine (`file://` pages
never attempt a live connection).

## Testing

```bash
npm test        # node --test — 15 tests, two suites
```

- **tests/server.test.js** — the classification contract: RFC 9421 detection,
  the known-UA matrix, shadow confidence, log parsing (nginx + JSON), and two
  regression guards (curl/library clients are never shadowed; the
  browser-claim heuristic applies only to live sockets, never to log lines).
- **tests/build.test.js** — `index.html` stays byte-in-sync with
  `styles.css` + `app.js`, the page has no external dependencies, honesty
  markers are present, and `server.js` guards side effects behind
  `require.main`.

CI runs the suite on Node 20, 22, and 24 and fails if a committed
`index.html` is out of sync with its sources.

## Project structure

```
index.html            generated, self-contained dashboard (the deliverable)
├── styles.css        theme + layout source
├── app.js            telemetry engine + live-capture module source
└── build.js          merge step (node build.js)
server.js             zero-dependency capture server: classifier, SSE, log tail
tests/                node:test suites (npm test)
scripts/screenshot.js headless-Chrome captures for the screenshots above
docs/                 screenshots, logo
```

**Editing workflow:** change `styles.css` / `app.js`, run `npm run build`,
commit both sources and the regenerated `index.html`. CI verifies the three
are consistent.

## Honest data labeling

The console distinguishes what it measures from what it models:

- `LIVE` — real requests captured by `server.js` (KPIs 1–3, header inspector,
  shadow feed, verification loop inputs).
- `SIM` — simulation of research findings and market forecasts (GEO citation
  economics, Pay-Per-Crawl revenue, IPI payload rates, TrjAD anomaly volume).
  Each simulated panel is tagged in the UI.

Verification verdicts are likewise literal: a captured request shows
`HEADERS OK · KEYS PENDING` unless a signature is actually validated.

## References

- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [Web Bot Auth](https://web-bot-auth.github.io/)
- [RFC 9309 — Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
- [GPTBot](https://openai.com/gptbot/)
- [Google-Extended](https://developers.google.com/search/docs/crawling-indexing/google-extended)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
build/test workflow, the `String.replace` pitfall that will silently corrupt
the generated dashboard, and commit-message conventions.

## License

[MIT](LICENSE) © anushms
