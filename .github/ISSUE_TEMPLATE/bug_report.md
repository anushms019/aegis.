---
name: Bug report
about: Something in AEGIS misbehaved
title: ""
labels: bug
assignees: ""
---

**What happened**

A clear description of the misbehaviour.

**What you expected instead**

If this is about a claim in the UI or the docs, quote it and say what the
code actually did — AEGIS promises that nothing is claimed the code does
not do, so wording bugs are bugs too.

**How to reproduce**

```bash
# exact commands, environment variables, and requests
```

**Environment**

- OS:
- Node version (`node -v`):
- AEGIS version / commit (`git rev-parse --short HEAD`):
- Bind/auth configuration (`HOST`, `AEGIS_AUTH_USERS` set or unset — never paste credentials):

**Relevant output**

Paste the server log, `/api/snapshot`, or the failing assertion. Redact
anything sensitive; do not attach key material or `.demo-jwks.json`.
