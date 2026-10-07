# syntax=docker/dockerfile:1
# AEGIS — multi-stage build: bundle the dashboard and gate on tests,
# then ship a minimal runtime image with no build tooling in it.

# ── stage 1: build + test ────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# No dependencies to install (zero-dependency project): copy sources only.
COPY package.json ./
COPY build.js styles.css server.js index.html ./
COPY src ./src
COPY tests ./tests

# Bundle src/*.js → app.js → index.html, then run the full suite so a
# broken image can never be produced.
RUN node build.js \
 && node --test tests/server.test.js tests/verify.test.js tests/jwks.test.js \
                tests/integration.test.js tests/build.test.js

# ── stage 2: minimal runtime ─────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788
WORKDIR /app

# Only what the server serves at runtime: server.js + the self-contained
# dashboard (index.html inlines styles.css and app.js).
COPY --from=build /app/server.js /app/index.html ./

USER node
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
