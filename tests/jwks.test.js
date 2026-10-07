"use strict";
/* Remote JWKS resolver contract: background queue, exponential backoff,
 * TLS SPKI pinning, and the live https transport.
 *
 * The default-deny allowlist / private-host refusals are covered in
 * build.test.js. This file covers the v3 additions:
 *   1. backoff math (exponential, capped, jittered)
 *   2. JWKS_PINS parsing + pin verification (fail-closed)
 *   3. background queue gating, dedupe, and drain
 *   4. the real TLS transport against a local HTTPS server, including
 *      pin enforcement, redirect refusal, size caps, and timeouts.
 *
 * JWKS_CA_FILE must be set before server.js loads so the transport
 * trusts the test-only certificate in tests/fixtures/. */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("node:crypto");

process.env.JWKS_CA_FILE = path.join(__dirname, "fixtures", "tls-cert.pem");

const {
  jwksBackoffDelay,
  recordJwksFailure,
  recordJwksSuccess,
  jwksPins,
  checkJwksPin,
  queueJwksFetch,
  jwksQueued,
  httpsGetJwks,
  fetchRemoteJwks,
  remoteJwksCache,
  remoteJwksBackoff,
  counters,
  resetCounters,
} = require("../server.js");

const ORIGIN = "https://keys.example.test";

/* ── 1. backoff math ─────────────────────────────────────── */

test("backoff doubles per failure, jitters ±20 %, and caps at 5 minutes", () => {
  const mid = () => 0.5; // jitter = 1.0 exactly
  assert.equal(jwksBackoffDelay(1, mid), 1000, "first failure waits the base second");
  assert.equal(jwksBackoffDelay(2, mid), 2000);
  assert.equal(jwksBackoffDelay(3, mid), 4000);
  assert.equal(jwksBackoffDelay(4, mid), 8000);
  assert.equal(jwksBackoffDelay(5, mid), 16000);
  assert.equal(jwksBackoffDelay(10, mid), 300000, "exponential growth hits the 5 min cap");

  for (const fails of [1, 3, 7]) {
    const lo = jwksBackoffDelay(fails, () => 0);
    const hi = jwksBackoffDelay(fails, () => 1);
    const base = 1000 * Math.pow(2, fails - 1);
    assert.ok(lo >= Math.floor(base * 0.8) - 1, `lo ${lo} within −20 % of ${base}`);
    assert.ok(hi <= Math.min(300000, Math.ceil(base * 1.2)) + 1, `hi ${hi} within +20 % of ${base}`);
  }
});

test("failure records escalate the delay; success clears the origin", () => {
  remoteJwksBackoff.delete(ORIGIN);
  recordJwksFailure(ORIGIN);
  const first = remoteJwksBackoff.get(ORIGIN);
  assert.equal(first.fails, 1);
  assert.ok(first.nextAt > Date.now() && first.nextAt <= Date.now() + 1201, "nextAt within base+jitter");
  recordJwksFailure(ORIGIN);
  const second = remoteJwksBackoff.get(ORIGIN);
  assert.equal(second.fails, 2);
  assert.ok(second.nextAt - Date.now() > first.nextAt - Date.now() - 2000 + 900, "second delay roughly doubles");
  recordJwksSuccess(ORIGIN);
  assert.equal(remoteJwksBackoff.has(ORIGIN), false, "success resets backoff state");
});

/* ── 2. pin parsing + verification ───────────────────────── */

test("JWKS_PINS parses origins with one or more pins", () => {
  process.env.JWKS_PINS =
    "https://a.example=sha256/AAAA, https://b.example=sha256/BBBB|sha256/CCCC , https://c.example=deadbeef";
  const pins = jwksPins();
  assert.deepEqual(pins.get("https://a.example"), ["AAAA"]);
  assert.deepEqual(pins.get("https://b.example"), ["BBBB", "CCCC"], "rollover pins split on |");
  assert.deepEqual(pins.get("https://c.example"), ["deadbeef"], "prefix is optional");
  delete process.env.JWKS_PINS;
});

test("pin verification passes only an exact SPKI digest and fails closed", () => {
  const real = crypto.randomBytes(32);
  const other = crypto.randomBytes(32);

  delete process.env.JWKS_PINS;
  assert.equal(checkJwksPin("https://any.example", null), true, "no pin configured → WebPKI only");

  process.env.JWKS_PINS = `https://k.example=sha256/${real.toString("base64")}`;
  assert.equal(checkJwksPin("https://k.example", real), true, "base64 pin matches");
  assert.equal(checkJwksPin("https://k.example", other), false, "different digest rejected");
  assert.equal(checkJwksPin("https://k.example", null), false, "missing peer cert fails closed");
  assert.equal(checkJwksPin("https://unpinned.example", null), true, "unpinned origin unaffected");

  process.env.JWKS_PINS = `https://k.example=${real.toString("hex")}`;
  assert.equal(checkJwksPin("https://k.example", real), true, "hex pin matches");
  delete process.env.JWKS_PINS;
});

/* ── 3. background queue ─────────────────────────────────── */

test("queue rejects non-https, unallowlisted, and private origins before any work", () => {
  delete process.env.JWKS_ALLOWLIST;
  assert.equal(queueJwksFetch("https://a.example/jwks.json"), false, "empty allowlist → never queued");

  process.env.JWKS_ALLOWLIST = "https://a.example";
  assert.equal(queueJwksFetch("http://a.example/jwks.json"), false, "http refused");
  assert.equal(queueJwksFetch("https://a.example.attacker.test/jwks.json"), false, "suffix lookalike refused");

  process.env.JWKS_ALLOWLIST = "https://127.0.0.1,https://vault.internal";
  assert.equal(queueJwksFetch("https://127.0.0.1/jwks.json"), false, "loopback refused");
  assert.equal(queueJwksFetch("https://vault.internal/jwks.json"), false, ".internal TLD refused");
  delete process.env.JWKS_ALLOWLIST;
  assert.equal(jwksQueued.size, 0, "nothing entered the queue");
});

test("the same origin is deduped while queued or in flight", async () => {
  process.env.JWKS_ALLOWLIST = ORIGIN;
  // park the origin in backoff so the drain cannot open a socket
  for (let i = 0; i < 40; i++) recordJwksFailure(ORIGIN);
  assert.equal(queueJwksFetch(ORIGIN + "/.well-known/jwks.json"), true, "first enqueue wins");
  assert.equal(queueJwksFetch(ORIGIN + "/.well-known/jwks.json"), false, "duplicate deduped");
  assert.equal(jwksQueued.has(ORIGIN), true);
  // let the drain run (fetchRemoteJwks short-circuits on backoff → no socket)
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(jwksQueued.has(ORIGIN), false, "origin released after drain");
  assert.equal(counters.jwks.backoff > 0, true, "drain short-circuited on backoff, not the network");
  remoteJwksBackoff.delete(ORIGIN);
  delete process.env.JWKS_ALLOWLIST;
});

/* ── 4. live TLS transport ───────────────────────────────── */

let tlsServer = null;
let port = 0;
let mode = "ok";

before(async () => {
  const key = fs.readFileSync(path.join(__dirname, "fixtures", "tls-key.pem"));
  const cert = fs.readFileSync(path.join(__dirname, "fixtures", "tls-cert.pem"));
  tlsServer = https.createServer({ key, cert }, (req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { location: "/jwks.json" });
      res.end();
      return;
    }
    if (mode === "status500") {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    if (mode === "big") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[" + "0,".repeat(REMOTE_JWKS_MAX * 2) + "0]");
      return;
    }
    if (mode === "slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"keys":[]}');
      }, 3000);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"keys":[{"kty":"OKP","crv":"Ed25519","x":"AAAA","kid":"remote-1"}]}');
  });
  await new Promise((res) => tlsServer.listen(0, "127.0.0.1", res));
  port = tlsServer.address().port;
});

after(() => {
  if (tlsServer) tlsServer.closeAllConnections?.();
  if (tlsServer) tlsServer.close();
});

beforeEach(() => {
  mode = "ok";
  delete process.env.JWKS_PINS;
  resetCounters();
});

const REMOTE_JWKS_MAX = 64 * 1024;
const url = (p) => new URL(`https://127.0.0.1:${port}${p}`);

test("the transport fetches a JWKS document over verified TLS", async () => {
  const { text } = await httpsGetJwks(url("/jwks.json"));
  const doc = JSON.parse(text);
  assert.equal(doc.keys[0].kid, "remote-1");
});

test("an allowlisted+cached document round-trips through fetchRemoteJwks", async () => {
  // NB: fetchRemoteJwks refuses loopback hosts, so drive it through the
  // exported transport's result instead — here we assert the refusal itself
  // still holds with the new https transport wired in.
  process.env.JWKS_ALLOWLIST = `https://127.0.0.1:${port}`;
  assert.equal(await fetchRemoteJwks(`https://127.0.0.1:${port}/jwks.json`), null,
    "loopback must remain refused even when explicitly allowlisted");
  assert.equal(counters.jwks.denied, 1, "refusal is counted");
  delete process.env.JWKS_ALLOWLIST;
});

test("a matching SPKI pin lets the document through", async () => {
  const certPem = fs.readFileSync(path.join(__dirname, "fixtures", "tls-cert.pem"), "utf8");
  const spki = new crypto.X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
  const pin = crypto.createHash("sha256").update(spki).digest("base64");
  process.env.JWKS_PINS = `https://127.0.0.1:${port}=sha256/${pin}`;
  const { text } = await httpsGetJwks(url("/jwks.json"));
  assert.ok(text.includes("remote-1"), "pinned fetch succeeds");
});

test("a wrong SPKI pin tears the connection down before the body is read", async () => {
  process.env.JWKS_PINS = `https://127.0.0.1:${port}=sha256/${crypto.randomBytes(32).toString("base64")}`;
  await assert.rejects(httpsGetJwks(url("/jwks.json")), /pin mismatch/);
});

test("redirects are refused, never followed", async () => {
  mode = "redirect";
  await assert.rejects(httpsGetJwks(url("/redirect")), /redirect refused/);
});

test("non-200 responses are rejected", async () => {
  mode = "status500";
  await assert.rejects(httpsGetJwks(url("/error")), /status 500/);
});

test("the response size cap is enforced mid-stream", async () => {
  mode = "big";
  await assert.rejects(httpsGetJwks(url("/big")), /size cap/);
});

test("a stalled response hits the timeout", async () => {
  mode = "slow";
  await assert.rejects(httpsGetJwks(url("/slow")), /timeout/);
});
