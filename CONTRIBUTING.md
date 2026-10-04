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

There is nothing to install — no dependencies, no lockfile, no build tooling
beyond `build.js`.

## Making changes

`index.html` is **generated**. It is the merge of two sources:

| File        | Contains                                        |
| ----------- | ----------------------------------------------- |
| `styles.css` | theme, layout, all CSS                          |
| `app.js`     | telemetry engine, visualizations, live capture  |
| `build.js`   | the merge (must use function replacers — see below) |

Edit `styles.css` / `app.js`, then regenerate:

```bash
npm run build           # node build.js → rewrites index.html
npm test                # verifies index.html is in sync with the sources
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
- `tests/build.test.js` — `index.html` is in sync with the sources, the page is
  self-contained (no external requests), honesty markers are present, and the
  server guards side effects behind `require.main`.

CI runs the same suite plus a `git diff --exit-code` check on `index.html`
across Node 20/22/24. Please make sure both pass locally before opening a PR.

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
3. Regenerate `index.html` if you touched `styles.css` or `app.js`.
4. Keep the professional, factual tone used throughout the docs: no hype,
   no claims the code does not honor.

## Reporting issues

Include the Node version, your OS, the command you ran, and the exact output.
For classification bugs, attach an anonymized access-log line that reproduces
the misclassification — there is likely a test to add alongside the fix.
