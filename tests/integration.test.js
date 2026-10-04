"use strict";
/* End-to-end tests: boot the real capture server on an ephemeral port and
 * exercise it over HTTP — classification, signature verdicts, snapshot
 * counters, and the SSE stream (hydration + live broadcast). */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { server, snapshot, resetCounters, addVerificationKey } = require("../server.js");

let base;
const pair = crypto.generateKeyPairSync("ed25519");
addVerificationKey({
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "integration-key", alg: "ed25519",
});

before(async () => {
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${server.address().port}`;
  resetCounters();
});

after(async () => {
  if (sseRes) { try { await sseRes.body.cancel(); } catch (_) {} }
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((res) => server.close(res));
});

/* ── helpers ──────────────────────────────────────────────── */
/* Sign a GET over the RFC 9421 base, built independently of server.js. */
async function signedFetch(path, { kid = "integration-key", tamperPath = false, key = pair.privateKey } = {}) {
  const host = base.slice("http://".length);
  const now = Math.floor(Date.now() / 1000);
  const input = `("@method" "@path" "@authority");created=${now};keyid="${kid}"`;
  const base0 = [
    `"@method": GET`,
    `"@path": ${tamperPath ? "/tampered" : path}`,
    `"@authority": ${host}`,
    `"@signature-params": ${input}`,
  ].join("\n");
  const sig = crypto.sign(null, Buffer.from(base0, "utf8"), key).toString("base64");
  return fetch(base + path, {
    headers: {
      "user-agent": "Signed-Integration/1.0",
      "signature-input": `sig1=${input}`,
      "signature": `sig1=:${sig}:`,
    },
  });
}

/* Persistent SSE reader: frames arrive on one stream, so keep the reader
 * and buffer across waits instead of re-reading from a consumed body. */
let sseRes = null, sseReader = null, sseBuf = "";
async function nextSse(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    while (sseBuf.includes("\n\n")) {
      const idx = sseBuf.indexOf("\n\n");
      const frame = sseBuf.slice(0, idx);
      sseBuf = sseBuf.slice(idx + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const obj = JSON.parse(line.slice(6));
      if (predicate(obj)) return obj;
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const { value, done } = await Promise.race([
      sseReader.read(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for SSE frame")), remain)),
    ]);
    if (done) break;
    sseBuf += new TextDecoder().decode(value, { stream: true });
  }
  throw new Error("expected SSE frame never arrived");
}

/* ── tests (sequential: each asserts deltas, not absolutes) ─ */
test("telemetry endpoints are not counted as traffic", async () => {
  const before = snapshot().total;
  const h = await fetch(base + "/api/health");
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  assert.equal(snapshot().total, before, "health probe must not bump counters");
});

test("snapshot exposes kind and verdict breakdowns", async () => {
  const s = snapshot();
  assert.equal(s.type, "snapshot");
  for (const k of ["signed", "known", "shadow", "tool", "human"]) assert.ok(k in s.byKind, `byKind.${k}`);
  for (const k of ["valid", "invalid", "unresolved"]) assert.ok(k in s.byVerdict, `byVerdict.${k}`);
});

test("a correctly signed request is classified signed and verified valid", async () => {
  const before = snapshot();
  const res = await signedFetch("/index.html");
  assert.equal(res.status, 200);
  const after = snapshot();
  assert.equal(after.byKind.signed - before.byKind.signed, 1);
  assert.equal(after.byVerdict.valid - before.byVerdict.valid, 1);
});

test("a signed request whose path was tampered with counts invalid", async () => {
  const before = snapshot();
  await signedFetch("/index.html", { tamperPath: true });
  const after = snapshot();
  assert.equal(after.byVerdict.invalid - before.byVerdict.invalid, 1);
});

test("a signed request with an unknown keyid counts unresolved", async () => {
  const before = snapshot();
  await signedFetch("/index.html", { kid: "nobody-trusts-this" });
  const after = snapshot();
  assert.equal(after.byVerdict.unresolved - before.byVerdict.unresolved, 1);
});

test("known agent User-Agent is counted", async () => {
  const before = snapshot();
  await fetch(base + "/index.html", { headers: { "user-agent": "GPTBot/1.2" } });
  const after = snapshot();
  assert.equal(after.byKind.known - before.byKind.known, 1);
  assert.equal(after.byAgent.GPTBot, (before.byAgent.GPTBot || 0) + 1);
});

test("headless browser traffic is counted as shadow", async () => {
  const before = snapshot();
  await fetch(base + "/index.html", {
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/128.0.0.0 Safari/537.36" },
  });
  const after = snapshot();
  assert.equal(after.byKind.shadow - before.byKind.shadow, 1);
});

test("static dashboard is served and its path counted", async () => {
  const before = snapshot();
  const res = await fetch(base + "/index.html");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("AEGIS"), "dashboard HTML should be served");
  const after = snapshot();
  assert.equal(after.byPath["/index.html"] - (before.byPath["/index.html"] || 0), 1);
});

test("SSE stream hydrates with a snapshot then broadcasts live events", async () => {
  sseRes = await fetch(base + "/events");
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get("content-type") || "", /text\/event-stream/);
  sseReader = sseRes.body.getReader();
  sseBuf = "";

  const hydrated = await nextSse((o) => o.type === "snapshot");
  assert.ok(hydrated.total >= 0 && hydrated.byKind, "hydration snapshot must carry counters");

  await fetch(base + "/index.html", { headers: { "user-agent": "PerplexityBot/1.0" } });
  const ev = await nextSse((o) => o.kind === "known" && o.agent && o.agent.name === "PerplexityBot");
  assert.equal(ev.source, "http");
  assert.equal(ev.path, "/index.html");
});
