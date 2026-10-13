## What changed, and why

<!-- One or two sentences on the problem this solves. -->

## Honesty check

AEGIS promises that nothing is claimed the code does not do.

- [ ] Every new or edited UI string, README line and doc claim is something
      this code actually does.
- [ ] Any figure that is not fed by live capture is tagged `SIM`
      (and any live panel is tagged `LIVE`).
- [ ] No new security default was loosened (SSRF, auth, verdict, allowlist).

## Verification

- [ ] `npm test` passes locally (paste the total).
- [ ] `node build.js && git diff --exit-code app.js index.html`
      (sources and generated bundle are in sync).
- [ ] New behaviour is covered by a test, or the manual check is described
      above.
