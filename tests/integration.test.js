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

test("scraping /metrics returns Prometheus exposition without counting itself", async () => {
  const before = snapshot().total;
  const res = await fetch(base + "/metrics");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/plain; version=0\.0\.4/);
  const text = await res.text();
  assert.match(text, /# TYPE aegis_events_total counter/);
  assert.match(text, /# TYPE aegis_verifications_total counter/);
  assert.match(text, /# TYPE aegis_request_duration_seconds histogram/);
  assert.match(text, /aegis_request_duration_seconds_bucket\{le="\+Inf"\} \d+/);
  assert.match(text, /aegis_request_duration_seconds_sum [\d.]+/);
  assert.match(text, /aegis_events_per_minute \d+/);
  assert.equal(snapshot().total, before, "metrics scrape must not bump event counters");
});

test("metrics counters advance with real traffic (pass/fail ratio + latency)", async () => {
  const scrape = async () => {
    const t = await (await fetch(base + "/metrics")).text();
    const get = (re) => {
      const m = t.match(re);
      assert.ok(m, `metric missing in scrape: ${re}`);
      return Number(m[1]);
    };
    return {
      known: get(/aegis_events_total\{kind="known"\} (\d+)/),
      valid: get(/aegis_verifications_total\{verdict="valid"\} (\d+)/),
      invalid: get(/aegis_verifications_total\{verdict="invalid"\} (\d+)/),
      count: get(/aegis_request_duration_seconds_count (\d+)/),
      sum: get(/aegis_request_duration_seconds_sum ([\d.]+)/),
    };
  };
  const before = await scrape();
  await fetch(base + "/index.html", { headers: { "user-agent": "GPTBot/9.0" } });
  await signedFetch("/index.html");
  const after = await scrape();
  assert.equal(after.known, before.known + 1, "known agent request counted");
  assert.equal(after.valid, before.valid + 1, "verification pass counted");
  assert.equal(after.count, before.count + 2, "both requests observed by latency histogram");
  assert.ok(after.sum >= before.sum, "latency sum is monotonic");
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

test("per-path cardinality and key length are capped (unique-path flood)", async () => {
  // 250 distinct paths, one absurdly long: an attacker-controlled map
  // must not grow memory or snapshot payloads without bound
  for (let i = 0; i < 250; i++) {
    await fetch(base + "/flood-" + i, { headers: { "user-agent": "curl/8.5.0" } });
  }
  await fetch(base + "/" + "x".repeat(4000), { headers: { "user-agent": "curl/8.5.0" } });

  const snap = snapshot();
  const keys = Object.keys(snap.byPath);
  assert.ok(keys.length <= 200, `byPath grew to ${keys.length} entries (cap 200)`);
  for (const k of keys) {
    assert.ok(k.length <= 201, `byPath key not truncated: ${k.length} chars`);
  }
  const payload = JSON.stringify(snap);
  assert.ok(payload.length < 64 * 1024, `snapshot payload too large: ${payload.length}`);
  assert.equal(snapshot().total, snap.total, "snapshot must stay idempotent");
});

test("reconnecting SSE re-hydrates absolute counters without double counting", async () => {
  const grab = async () => {
    const res = await fetch(base + "/events");
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const reader = res.body.getReader();
    let buf = "";
    let idx = -1, end = -1;
    // the stream opens with `retry: 2000` before the data frame
    for (;;) {
      idx = buf.indexOf("data: ");
      end = idx >= 0 ? buf.indexOf("\n\n", idx) : -1;
      if (end >= 0) break;
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString("utf8");
    }
    try { await reader.cancel(); } catch (_) {}
    assert.ok(end > 0, "hydration frame missing");
    return JSON.parse(buf.slice(idx + "data: ".length, end));
  };
  const a = await grab();
  assert.equal(a.type, "snapshot");
  const b = await grab();
  assert.equal(a.total, b.total, "hydration totals must be idempotent across reconnects");
  assert.equal(snapshot().total, b.total, "hydration must mirror server counters exactly");
});

/* ── authentication & RBAC ──────────────────────────────── */
const basic = (u, p) => ({ authorization: "Basic " + Buffer.from(u + ":" + p).toString("base64") });

test("AEGIS_AUTH_USERS enables HTTP Basic auth with role-based access", async () => {
  process.env.AEGIS_AUTH_USERS =
    "adminUser:adm:admin,viewerUser:vew:viewer,scrapeR:srp:metrics,badRole:pwd:notarole";
  try {
    // probes stay open so container healthchecks keep working
    assert.equal((await fetch(base + "/api/health")).status, 200);

    // no credentials → 401 with a Basic challenge
    const r401 = await fetch(base + "/");
    assert.equal(r401.status, 401);
    assert.match(r401.headers.get("www-authenticate") || "", /Basic/);
    assert.equal(r401.headers.get("cache-control"), "no-store");

    // wrong password → 401
    assert.equal((await fetch(base + "/", { headers: basic("adminUser", "nope") })).status, 401);

    // an entry with an unknown role is dropped — a typo fails closed
    assert.equal((await fetch(base + "/", { headers: basic("badRole", "pwd") })).status, 401);

    // viewer: dashboard and snapshot yes, /metrics no
    assert.equal((await fetch(base + "/", { headers: basic("viewerUser", "vew") })).status, 200);
    assert.equal((await fetch(base + "/api/snapshot", { headers: basic("viewerUser", "vew") })).status, 200);
    assert.equal((await fetch(base + "/metrics", { headers: basic("viewerUser", "vew") })).status, 403);

    // metrics role: /metrics only
    assert.equal((await fetch(base + "/metrics", { headers: basic("scrapeR", "srp") })).status, 200);
    assert.equal((await fetch(base + "/", { headers: basic("scrapeR", "srp") })).status, 403);

    // admin: everything
    assert.equal((await fetch(base + "/metrics", { headers: basic("adminUser", "adm") })).status, 200);
    assert.equal((await fetch(base + "/api/snapshot", { headers: basic("adminUser", "adm") })).status, 200);
    assert.equal((await fetch(base + "/", { headers: basic("adminUser", "adm") })).status, 200);

    // refusals are observable to operators via /metrics
    const m = await (await fetch(base + "/metrics", { headers: basic("adminUser", "adm") })).text();
    assert.match(m, /aegis_auth_failures_total\{result="unauthorized"\} [1-9]/);
    assert.match(m, /aegis_auth_failures_total\{result="forbidden"\} [1-9]/);
  } finally {
    delete process.env.AEGIS_AUTH_USERS;
  }
});

test("malformed AEGIS_AUTH_USERS fails closed", async () => {
  process.env.AEGIS_AUTH_USERS = "garbage-without-colon";
  try {
    assert.equal((await fetch(base + "/")).status, 401, "config with zero parseable users must deny");
    assert.equal((await fetch(base + "/api/health")).status, 200, "probes stay open");
  } finally {
    delete process.env.AEGIS_AUTH_USERS;
  }
});

test("auth disabled (default) leaves every route open", async () => {
  delete process.env.AEGIS_AUTH_USERS;
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/metrics")).status, 200);
});

/* ── OTLP/HTTP exporter ─────────────────────────────────── */

test("OTLP/HTTP exporter pushes request spans to a collector", async () => {
  const httpMod = require("node:http");
  const batches = [];
  const collector = httpMod.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      batches.push({ url: req.url, body: JSON.parse(b) });
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise((r) => collector.listen(0, "127.0.0.1", r));
  process.env.OTLP_ENDPOINT = `http://127.0.0.1:${collector.address().port}`;
  try {
    // fill one batch so the export fires immediately (batch size 32)
    for (let i = 0; i < 32; i++) {
      await fetch(base + "/otlp-" + i, { headers: { "user-agent": "curl/8.5.0" } });
    }
    const deadline = Date.now() + 3000;
    while (!batches.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(batches.length, "collector received no batch");

    // batches may split if the interval timer fires mid-loop — count spans
    // across every batch, but require each to target the OTLP signal path
    for (const b of batches) assert.equal(b.url, "/v1/traces");
    const allSpans = batches.flatMap((b) => b.body.resourceSpans[0].scopeSpans[0].spans);
    assert.ok(allSpans.length >= 32, `expected >= 32 spans total, got ${allSpans.length}`);
    const svc = batches[0].body.resourceSpans[0].resource.attributes;
    assert.ok(svc.some((a) => a.key === "service.name" && a.value.stringValue === "aegis"));

    const s = allSpans[0];
    assert.match(s.traceId, /^[0-9a-f]{32}$/);
    assert.match(s.spanId, /^[0-9a-f]{16}$/);
    assert.match(s.name, /^GET \/otlp-\d+$/);
    assert.equal(s.kind, 3, "spans must be SPAN_KIND_SERVER");
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
    const attrs = Object.fromEntries(s.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.equal(attrs["http.request.method"], "GET");
    assert.match(attrs["url.path"], /^\/otlp-\d+$/);
    assert.equal(attrs["aegis.kind"], "tool");
    assert.equal(attrs["user_agent.original"], "curl/8.5.0");

    const m = await (await fetch(base + "/metrics")).text();
    assert.match(m, /aegis_otlp_exports_total\{result="ok"\} [1-9]/);
  } finally {
    delete process.env.OTLP_ENDPOINT;
    collector.close();
  }
});

test("OTLP export failures are counted, never thrown", async () => {
  // point at a closed port: the flush must fail soft and stay observable
  process.env.OTLP_ENDPOINT = "http://127.0.0.1:9";
  try {
    for (let i = 0; i < 32; i++) {
      await fetch(base + "/otlp-fail-" + i, { headers: { "user-agent": "curl/8.5.0" } });
    }
    const deadline = Date.now() + 4000;
    let m = "";
    while (Date.now() < deadline) {
      m = await (await fetch(base + "/metrics")).text();
      if (/aegis_otlp_exports_total\{result="error"\} [1-9]/.test(m)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(m, /aegis_otlp_exports_total\{result="error"\} [1-9]/, "failed export must be counted");
    assert.equal((await fetch(base + "/api/health")).status, 200, "server must stay healthy after export failures");
  } finally {
    delete process.env.OTLP_ENDPOINT;
  }
});
