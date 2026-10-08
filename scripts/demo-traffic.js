/* scripts/demo-traffic.js — light up the dashboard with realistic traffic,
 * including cryptographically signed RFC 9421 requests.
 *
 * Usage:
 *   JWKS_PATH=.demo-jwks.json node server.js   # terminal 1
 *   node scripts/demo-traffic.js               # terminal 2
 *
 * Generates an ephemeral Ed25519 keypair, publishes the public half to
 * .demo-jwks.json (the server reloads JWKS_PATH whenever the file changes),
 * then fires:
 *   - validly signed requests        → verdict VALID
 *   - requests signed with the wrong key, claiming a known kid → INVALID
 *   - requests signed by a key that is not in the keyring      → UNRESOLVED
 *   - shadow / known-bot / tool / human traffic
 *
 * The shadow burst is intentionally large enough to trip the dashboard's
 * burst detector.
 *
 * Finally it re-scrapes GET /metrics and diffs against a baseline captured
 * before the burst, proving the Prometheus counters account for every
 * fired request (extra traffic only ever adds to the delta). A shortfall
 * exits non-zero so CI and wrapper scripts can gate on it.
 */
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 8788;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const JWKS_OUT = process.env.JWKS_PATH || path.join(process.cwd(), ".demo-jwks.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── keys ─────────────────────────────────────────────────── */
const pair = crypto.generateKeyPairSync("ed25519");
const pubJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "demo-agent-1", alg: "ed25519" };
fs.writeFileSync(JWKS_OUT, JSON.stringify({ keys: [pubJwk] }, null, 2));
console.log(`[demo] public JWKS written → ${JWKS_OUT}`);

const stranger = crypto.generateKeyPairSync("ed25519"); // never published → UNRESOLVED
const wrongKey = crypto.generateKeyPairSync("ed25519"); // published kid, wrong bytes → INVALID

/* ── RFC 9421 signing (mirrors the verifier's base format) ── */
function signHeaders(urlPath, { key = pair.privateKey, kid = "demo-agent-1", signPath = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `("@method" "@path" "@authority");created=${now};keyid="${kid}"`;
  const qi = urlPath.indexOf("?");
  const pth = qi === -1 ? urlPath : urlPath.slice(0, qi);
  const base = [
    `"@method": GET`,
    `"@path": ${signPath || pth}`,
    `"@authority": 127.0.0.1:${PORT}`,
    `"@signature-params": ${input}`,
  ].join("\n");
  const sig = crypto.sign(null, Buffer.from(base, "utf8"), key).toString("base64");
  return {
    "signature-input": `sig1=${input}`,
    "signature": `sig1=:${sig}:`,
    "signature-agent": `https://demo.local/.well-known/http-message-signatures-directory#kid=${kid}`,
  };
}

/* ── traffic plan ─────────────────────────────────────────── */
const KNOWN_UAS = [
  "GPTBot/1.2", "ClaudeBot/1.0", "PerplexityBot/1.0", "Google-Extended",
  "CCBot/2.0", "Bytespider", "bingbot/2.0", "Applebot/0.1",
];
const SHADOW_UAS = [
  // patched headless engine → automation rule
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36",
  // ordinary-looking Chrome with NO client hints → browser-claim heuristic
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  // automation framework in the UA
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Playwright/1.47.0",
];
const HUMAN_UAS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
];
const HUMAN_HINTS = { "sec-ch-ua": '"Chromium";v="127"', "accept-language": "en-US,en;q=0.9", "sec-fetch-mode": "navigate" };
const PATHS = [
  "/index.html", "/pricing", "/docs/quickstart", "/api/v1/catalog/search",
  "/products/88213", "/.well-known/robot.txt", "/blog/agent-economy",
];

async function hit(p, headers = {}) {
  try { await fetch(BASE + p, { headers }); } catch (e) { console.error("[demo] request failed:", e.message); }
}

/* Exact-header requests via node:http: undici's fetch always injects
 * accept-language/sec-fetch-mode, which would mask the browser-claim
 * heuristic we want to demonstrate. */
function rawHit(p, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: p, method: "GET", headers },
      (res) => { res.resume(); res.on("end", resolve); }
    );
    req.on("error", resolve);
    req.end();
  });
}

/* ── Prometheus scrape helpers ─────────────────────────────── */
async function scrapeMetrics() {
  try {
    const res = await fetch(`${BASE}/metrics`);
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

/* Pull one labeled counter out of the exposition text without regex
 * escaping headaches: match the exact `name{label="v"} value` line. */
function metricValue(text, name, labelKey, labelVal) {
  if (!text) return 0;
  const want = `${name}{${labelKey}="${labelVal}"} `;
  for (const line of text.split("\n")) {
    if (line.startsWith(want)) return Number(line.slice(want.length)) || 0;
  }
  return 0;
}

async function main() {
  try {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    if (!h.ok) throw new Error("not ok");
  } catch (e) {
    console.error(`[demo] cannot reach ${BASE} — start the server first:\n  JWKS_PATH=.demo-jwks.json node server.js`);
    process.exit(1);
  }
  const baseline = await scrapeMetrics(); // null on servers without /metrics
  console.log(`[demo] firing traffic at ${BASE} …`);

  const tally = { valid: 0, invalid: 0, unresolved: 0, known: 0, shadow: 0, tool: 0, human: 0 };

  // 1 · honestly signed requests
  for (let i = 0; i < 6; i++) {
    const p = PATHS[i % PATHS.length];
    await hit(p, { "user-agent": "AEGIS-Demo-Agent/1.0", ...signHeaders(p) });
    tally.valid++; await sleep(80);
  }
  // 2 · signature made with the wrong private key but claiming demo-agent-1
  for (let i = 0; i < 3; i++) {
    const p = PATHS[(i + 3) % PATHS.length];
    await hit(p, { "user-agent": "Spoofed-Agent/1.0", ...signHeaders(p, { key: wrongKey.privateKey }) });
    tally.invalid++; await sleep(80);
  }
  // 3 · signed by a key nobody published
  for (let i = 0; i < 3; i++) {
    const p = PATHS[(i + 1) % PATHS.length];
    await hit(p, { "user-agent": "Unknown-Agent/1.0", ...signHeaders(p, { key: stranger.privateKey, kid: "ghost-key-9" }) });
    tally.unresolved++; await sleep(80);
  }
  // 4 · shadow traffic — large enough to trip the burst detector (≥8 / 60 s)
  for (let i = 0; i < 9; i++) {
    await rawHit(PATHS[i % PATHS.length], { "user-agent": SHADOW_UAS[i % SHADOW_UAS.length] });
    tally.shadow++; await sleep(70);
  }
  // 5 · known crawlers
  for (const ua of KNOWN_UAS) {
    await hit(PATHS[tally.known % PATHS.length], { "user-agent": ua });
    tally.known++; await sleep(60);
  }
  // 6 · scripted tools
  for (const ua of ["curl/8.5.0", "python-requests/2.31.0", "Go-http-client/2.0", "Wget/1.21"]) {
    await hit("/robots.txt", { "user-agent": ua });
    tally.tool++; await sleep(60);
  }
  // 7 · humans
  for (const ua of HUMAN_UAS) {
    await hit("/pricing", { "user-agent": ua, ...HUMAN_HINTS });
    tally.human++; await sleep(60);
  }
  // 8 · no User-Agent header at all (shadow: missing UA)
  await rawHit("/");
  tally.shadow++;

  console.log("[demo] done:", JSON.stringify(tally));
  console.log("[demo] open the dashboard — expect 6 valid, 3 invalid, 3 unresolved signatures and a shadow-burst banner.");
  await checkScrape(baseline, tally);
}

/* Prove the scrape reflects what we just fired: capture /metrics before
 * the burst, diff it after, and require the delta to cover every category.
 * Extra delta is allowed (other traffic, e.g. an open dashboard), a shortfall
 * is a real accounting bug. */
async function checkScrape(baseline, tally) {
  const after = await scrapeMetrics();
  if (!after) {
    console.log("[demo] /metrics not reachable — scrape check skipped.");
    return;
  }
  const signed = tally.valid + tally.invalid + tally.unresolved;
  const expect = [
    ["verdict", "valid", tally.valid],
    ["verdict", "invalid", tally.invalid],
    ["verdict", "unresolved", tally.unresolved],
  ].map(([k, v, n]) => ({
    label: `verdict=${v}`,
    delta: metricValue(after, "aegis_verifications_total", k, v) - metricValue(baseline, "aegis_verifications_total", k, v),
    want: n,
  })).concat(
    [["signed", signed], ["shadow", tally.shadow], ["known", tally.known], ["tool", tally.tool], ["human", tally.human]]
      .map(([k, n]) => ({
        label: `kind=${k}`,
        delta: metricValue(after, "aegis_events_total", "kind", k) - metricValue(baseline, "aegis_events_total", "kind", k),
        want: n,
      }))
  );
  let failed = 0;
  for (const c of expect) {
    const ok = c.delta >= c.want;
    if (!ok) failed++;
    const note = ok && c.delta > c.want ? ` (≥, +${c.delta - c.want} from other traffic)` : "";
    console.log(`[demo] scrape ${ok ? "ok  " : "FAIL"}  ${c.label.padEnd(18)} delta ${String(c.delta).padStart(3)} ≥ fired ${c.want}${note}`);
  }
  if (failed === 0) {
    console.log("[demo] scrape check PASSED — /metrics accounts for every fired request.");
    if (!baseline) console.log("[demo] (no baseline was available; deltas shown against zero)");
  } else {
    // exit non-zero so CI and wrapper scripts can gate on the accounting
    console.log(`[demo] scrape check FAILED — ${failed} counter(s) under-counted.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[demo] aborted:", e);
  process.exitCode = 1;
});
