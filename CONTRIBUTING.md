# Contributing to AEGIS

Thank you for considering a contribution. AEGIS is a zero-dependency Node.js
project: keep it that way unless a change genuinely cannot be made with the
standard library.

## Development setup

```bash
git clone <your-fork-url>
cd aegis
node server.js          # dashboard + capture server on http://127.0.0.1:8788
```

There is nothing to install — no dependencies, no lockfile. `build.js` is the
only build step.

## Making changes

The frontend is split into **modules under `src/`** (one file per panel /
concern). Two files are **generated** — edit the sources, never them:

| File              | Contains                                          |
| ----------------- | ------------------------------------------------- |
| `src/*.js`        | telemetry engine, split into 16 modules           |
| `styles.css`      | theme, layout, all CSS                            |
| `index.html`      | markup + the inlined `<style>`/`<script>` (built)  |
| `app.js`          | concatenated `src/*.js` (built, do not edit)       |
| `build.js`        | bundles `src/` → `app.js` → `index.html`           |

Edit `src/*.js` or `styles.css`, then regenerate:

```bash
npm run build           # node build.js → rewrites index.html
npm test                # all five suites (classification, verification, JWKS, integration, build sync)
```

> **Never** rewrite `index.html` by hand with a string-based `String.replace`
> replacer: a `$` followed by a digit or `$&` in the replacement is expanded,
> which silently corrupts template literals (`const $$x` → `const $x`). Always
> pass a **function** as the replacer. `build.js` does this; keep it that way.

## Testing

```bash
npm test
```

- `tests/server.test.js` — request classification contract: signed (RFC 9421),
  known agent UAs, shadow/headless detection, tool vs. human, and the two
  regression cases (curl must never be shadow; the browser-claim heuristic only
  applies to live sockets). Also covers nginx/JSON access-log parsing.
- `tests/verify.test.js` — RFC 9421 signature verification: the official
  Ed25519 vector from appendix B.2.6, Signature-Input parsing, signature-base
  construction, legacy `:component` normalization, algorithm registry, JWKS
  keyring handling, and the fail-closed policy (unknown `kid` → `unresolved`,
  never `valid`).
- `tests/jwks.test.js` — the remote-JWKS fetcher: backoff math, `JWKS_PINS`
  parsing and fail-closed pin verification, background-queue gating and
  dedupe, and the live stdlib-HTTPS transport (pin match/mismatch, redirect
  refusal, mid-stream size cap, timeout) against a local HTTPS server with a
  test-only CA (`tests/fixtures/`).
- `tests/integration.test.js` — spins up the real HTTP server on an ephemeral
  port: verdict counters move on signed traffic, SSE hydrates late readers and
  broadcasts live events, and `/metrics` renders Prometheus exposition without
  counting its own scrape. Also asserts the server makes **no outbound
  requests** (SSRF guard).
- `tests/build.test.js` — `index.html` is in sync with the sources, the page is
  self-contained (no external requests), honesty markers are present, the
  remote-JWKS path is default-deny behind the allowlist, the WebMCP inspector
  and its schema validator are wired in, and the server guards side effects
  behind `require.main`.

CI runs the same five suites plus a `git diff --exit-code` check on `index.html`
across Node 20/22/24. Please make sure they all pass locally before opening a PR.

## Commit messages

Follow the existing history: an imperative subject line prefixed with a scope,
e.g.

```
feat(server): classify requests by Web Bot Auth signature headers
fix(canvas): pin base height so dpr scaling cannot compound
docs: document LOG_PATH access-log tailing
```

Keep commits focused — one logical change per commit.

## Pull requests

1. One feature or fix per PR; describe the *why* in the PR body.
2. Add or extend tests for behavior changes.
3. Regenerate `app.js` / `index.html` if you touched `src/*.js` or `styles.css`.
4. Keep the professional, factual tone used throughout the docs: no hype,
   no claims the code does not honor.

## Reporting issues

Include the Node version, your OS, the command you ran, and the exact output.
For classification bugs, attach an anonymized access-log line that reproduces
the misclassification — there is likely a test to add alongside the fix.
