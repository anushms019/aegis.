/* server.js — AEGIS capture server (zero dependencies, Node stdlib)
 *
 * Serves the dashboard and observes REAL HTTP telemetry:
 *   GET /              → index.html (self-contained dashboard)
 *   GET /events        → Server-Sent Events stream of classified requests
 *   GET /api/snapshot  → aggregate counters (JSON)
 *   GET /api/health    → readiness probe
 *   GET /metrics       → Prometheus text exposition (v0.0.4)
 *   LOG_PATH=<file>    → optional: tail an nginx-style or JSON access log
 *                        and stream its parsed lines as events too
 *
 * Every request that is not dashboard telemetry itself (/events, /api/*)
 * is classified in real time:
 *   signed  — carries RFC 9421 Web Bot Auth headers
 *   known   — recognized agent User-Agent (GPTBot, ClaudeBot, ...)
 *   shadow  — headless/automation/absent-UA signals
 *   tool    — scripted client (curl, python-requests, ...)
 *   human   — ordinary browser request
 */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 8788;
// Containers must listen on all interfaces; the local default stays
// loopback-only so an unconfigured instance is never exposed.
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const LOG_PATH = process.env.LOG_PATH || null;

/* ── real agent User-Agent registry ─────────────────────── */
const UA_RULES = [
  [/GPTBot/i, "GPTBot", "OpenAI"],
  [/OAI-SearchBot/i, "OAI-SearchBot", "OpenAI"],
  [/ChatGPT-User/i, "ChatGPT-User", "OpenAI"],
  [/ClaudeBot|Claude-User|anthropic-ai/i, "ClaudeBot", "Anthropic"],
  [/PerplexityBot|Perplexity-User/i, "PerplexityBot", "Perplexity"],
  [/Google-Extended/i, "Google-Extended", "Google"],
  [/Googlebot|GoogleInspectionTool/i, "Googlebot", "Google"],
  [/CCBot/i, "CCBot", "Common Crawl"],
  [/Bytespider/i, "Bytespider", "ByteDance"],
  [/cohere-ai|cohere-training-data-crawler/i, "Cohere-Crawler", "Cohere"],
  [/Amazonbot/i, "Amazonbot", "Amazon"],
  [/Applebot/i, "Applebot", "Apple"],
  [/Meta-ExternalAgent|FacebookExternalHit/i, "Meta-ExternalAgent", "Meta"],
  [/bingbot|BingPreview/i, "bingbot", "Microsoft"],
  [/YandexBot|YandexImages/i, "YandexBot", "Yandex"],
  [/DuckDuckBot/i, "DuckDuckBot", "DuckDuckGo"],
  [/SemrushBot|AhrefsBot|MJ12bot|DotBot/i, "SEO-Crawler", "SEO vendor"],
  [/archive\.org|ia_archiver/i, "Wayback", "Internet Archive"],
  [/Diffbot/i, "Diffbot", "Diffbot"],
  [/PetalBot/i, "PetalBot", "Huawei"],
  [/Slurp/i, "Slurp", "Yahoo"],
];

/* ── automation / scripted-client signals ───────────────── */
const AUTOMATION_RULES = [
  [/HeadlessChrome/i, "Headless Chrome (patched-engine track)", 96],
  [/PhantomJS/i, "PhantomJS", 94],
  [/\bheadless\b/i, "headless client", 90],
  [/Playwright|Puppeteer|Selenium|WebDriver/i, "automation framework", 92],
];

/* plain scripted clients — not evasive, tracked as tool traffic (never shadow) */
const KNOWN_TOOL_SCRIPTED = [
  /^curl\//i,
  /python-requests|aiohttp|httpx|urllib\/|mechanize|Go-http-client|Wget|libcurl|okhttp|Java\/|Apache-HttpClient|PostmanRuntime/i,
];

function classify(req, source = "http") {
  const uaRaw = (req.headers["user-agent"] || "").trim();
  const ua = uaRaw === "-" ? "" : uaRaw;
  const sigInput = req.headers["signature-input"];
  const signature = req.headers["signature"];
  const sigAgent = req.headers["signature-agent"];
  const signed = !!(sigInput && signature);

  const headersOut = {};
  if (sigInput) headersOut["signature-input"] = String(sigInput).slice(0, 400);
  if (signature) headersOut["signature"] = String(signature).slice(0, 200);
  if (sigAgent) headersOut["signature-agent"] = String(sigAgent).slice(0, 400);
  if (req.headers["content-digest"]) headersOut["content-digest"] = String(req.headers["content-digest"]).slice(0, 200);

  if (signed) {
    return {
      kind: "signed",
      agent: { name: sigAgent ? "signed agent" : "signed client", op: "unresolved key" },
      signed: { present: true, input: String(sigInput), agent: sigAgent ? String(sigAgent) : null },
      headers: headersOut,
      shadow: null,
    };
  }

  for (const [re, signal, conf] of AUTOMATION_RULES) {
    if (re.test(ua)) {
      return { kind: "shadow", agent: { name: signal, op: "unsigned" }, signed: { present: false }, headers: headersOut, shadow: { signal, conf } };
    }
  }
  if (!ua) {
    return { kind: "shadow", agent: { name: "no user-agent", op: "unsigned" }, signed: { present: false }, headers: headersOut, shadow: { signal: "missing User-Agent header", conf: 71 } };
  }

  for (const [re, name, op] of UA_RULES) {
    if (re.test(ua)) return { kind: "known", agent: { name, op }, signed: { present: false }, headers: headersOut, shadow: null };
  }
  if (KNOWN_TOOL_SCRIPTED.some((re) => re.test(ua))) {
    return { kind: "tool", agent: { name: "scripted client", op: "developer tool" }, signed: { present: false }, headers: headersOut, shadow: null };
  }

  // Browser-claim heuristic: only meaningful on live sockets, where we actually
  // observe the full header set. Access-log lines don't record these headers,
  // so their absence there is not evidence of evasion.
  if (source === "http" && /Mozilla\/5\.0/i.test(ua) && !req.headers["accept-language"] && !req.headers["sec-ch-ua"] && !req.headers["sec-fetch-mode"]) {
    return { kind: "shadow", agent: { name: "browser claim, no client hints", op: "unsigned" }, signed: { present: false }, headers: headersOut, shadow: { signal: "Mozilla UA without sec-ch-ua / accept-language / sec-fetch-*", conf: 82 } };
  }

  return { kind: "human", agent: { name: "browser", op: "human" }, signed: { present: false }, headers: headersOut, shadow: null };
}

/* ── RFC 9421 HTTP Message Signatures — real verification ─────────────
   Parses Signature-Input / Signature (structured fields), rebuilds the
   signature base exactly as RFC 9421 §2.5 defines it, and verifies it
   against locally loaded JWK keys (JWKS_PATH file or addVerificationKey).
   Keyid URLs are NOT dereferenced by default: that would be an SSRF
   primitive (see SECURITY.md). Operators may opt in via JWKS_ALLOWLIST
   (+ optional JWKS_PINS) — key resolution stays explicit. */

// Components a signature must cover for AEGIS to trust it (Web Bot Auth profile).
const REQUIRED_COMPONENTS = ["@method", "@path", "@authority"];
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/;

/* Parse an sf-Dictionary of Signature-Input into
   [{ label, input, components:[{name, params}], params }] or null. */
function parseSignatureInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const entries = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    const lm = TOKEN_RE.exec(s.slice(i));
    if (!lm) return null;
    const label = lm[0];
    i += label.length;
    if (s[i] !== "=") return null;
    i++;
    if (s[i] !== "(") return null;
    // balanced, quote-aware scan of the inner list
    const valueStart = i;
    let depth = 0, j = i, inQ = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inQ) { if (c === "\\") { j++; continue; } if (c === '"') inQ = false; continue; }
      if (c === '"') { inQ = true; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0 || j >= s.length) return null;
    const inner = s.slice(valueStart + 1, j);
    i = j + 1;
    // signature parameters run to the next top-level comma (quote-aware)
    let pe = i, pq = false;
    while (pe < s.length) {
      const c = s[pe];
      if (pq) { if (c === "\\") { pe += 2; continue; } if (c === '"') pq = false; }
      else if (c === '"') pq = true;
      else if (c === ",") break;
      pe++;
    }
    const input = s.slice(valueStart, pe); // exact string for @signature-params
    const paramsStr = s.slice(i, pe).replace(/^;/, "");
    i = pe + 1;
    // inner-list members: ("comp" "comp";param=x comp2)
    const components = [];
    let k = 0;
    while (k < inner.length) {
      while (k < inner.length && /\s/.test(inner[k])) k++;
      if (k >= inner.length) break;
      let name = "";
      if (inner[k] === '"') {
        k++;
        while (k < inner.length && inner[k] !== '"') { if (inner[k] === "\\") k++; name += inner[k]; k++; }
        k++;
      } else {
        // lenient: accept bare token names, including legacy ":method" / "@method" forms
        const m = /^[!#$%&'*+.^_`|~0-9A-Za-z:@-]+/.exec(inner.slice(k));
        if (!m) return null;
        name = m[0];
        k += m[0].length;
      }
      let params = "";
      while (k < inner.length && inner[k] === ";") {
        const ps = k;
        k++;
        while (k < inner.length && !/[\s;=]/.test(inner[k])) k++;
        if (k < inner.length && inner[k] === "=") {
          k++;
          if (k < inner.length && inner[k] === '"') {
            k++;
            while (k < inner.length && inner[k] !== '"') { if (inner[k] === "\\") k++; k++; }
            k++;
          } else {
            while (k < inner.length && !/\s/.test(inner[k]) && inner[k] !== ";") k++;
          }
        }
        params += inner.slice(ps, k);
      }
      if (name) components.push({ name, params });
    }
    if (!components.length) return null;
    // top-level parameters → object (string params unquoted, like keyid)
    const params = {};
    let p = paramsStr, pi = 0;
    while (pi < p.length) {
      const eq = p.indexOf("=", pi);
      if (eq === -1) break;
      const key = p.slice(pi, eq).replace(/^;+/, "").trim();
      let v, q = eq + 1;
      if (p[q] === '"') {
        let out = ""; q++;
        while (q < p.length && p[q] !== '"') { if (p[q] === "\\") { q++; continue; } out += p[q]; q++; }
        q++;
        v = out;
      } else {
        let out = "";
        while (q < p.length && p[q] !== ";") { out += p[q]; q++; }
        v = out.trim();
      }
      if (key) params[key] = v;
      while (q < p.length && p[q] !== ";") q++;
      pi = q + 1;
    }
    entries.push({ label, input, components, params });
  }
  return entries.length ? entries : null;
}

/* Parse an sf-Dictionary of Signature byte sequences → { label: base64 }. */
function parseSignatureHeader(raw) {
  const out = {};
  const s = String(raw || "");
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    const lm = TOKEN_RE.exec(s.slice(i));
    if (!lm) break;
    const label = lm[0];
    i += label.length;
    if (s[i] !== "=") { while (i < s.length && s[i] !== ",") i++; continue; }
    i++;
    if (s[i] !== ":") { while (i < s.length && s[i] !== ",") i++; continue; }
    i++;
    if (s[i] === '"') i++; // tolerate a quoted byte sequence
    let b64 = "";
    while (i < s.length && s[i] !== '"' && s[i] !== ":" && s[i] !== ",") { b64 += s[i]; i++; }
    if (s[i] === '"') i++;
    if (s[i] === ":") i++;
    out[label] = b64;
    while (i < s.length && s[i] !== ",") i++;
    i++;
  }
  return out;
}

/* Rebuild the signature base for one label (RFC 9421 §2.5):
   "component": value\n … \n"@signature-params": <input>            */
function signatureBase(req, entry) {
  const raw = String(req.url || "");
  const qi = raw.indexOf("?");
  const pth = qi === -1 ? raw : raw.slice(0, qi);
  const qry = qi === -1 ? "" : raw.slice(qi + 1);
  const headers = req.headers || {};
  const lines = [];
  const seen = new Set();
  for (const comp of entry.components) {
    if (seen.has(comp.name)) return { error: `duplicate component "${comp.name}"` };
    seen.add(comp.name);
    const n = comp.name;
    const d = n.startsWith(":") ? "@" + n.slice(1) : n; // legacy ":method" form → "@method"
    if (comp.params) {
      const allowed = /^(;sf|;bs|;req|;tr)(?=;|$)/;
      if (!allowed.test(comp.params)) return { error: `unsupported component parameters ${comp.params} on "${n}"` };
      if (/;req/.test(comp.params)) return { error: `req parameter invalid on a request message ("${n}")` };
      return { error: `component parameter ${comp.params} is not implemented ("${n}")` };
    }
    let value;
    if (d === "@method") value = String(req.method || "GET");
    else if (d === "@path") value = pth;
    else if (d === "@query") value = qry;
    else if (d === "@request-target") value = raw;
    else if (d === "@authority") {
      value = String(headers.host || "").toLowerCase().replace(/:(80|443)$/, "");
    } else if (d.startsWith("@")) return { error: `unsupported derived component ${d}` };
    else {
      const v = headers[n.toLowerCase()];
      if (v === undefined) return { error: `covered field "${n}" not present on the request` };
      value = (Array.isArray(v) ? v.join(", ") : String(v)).trim();
    }
    lines.push(`"${n}": ${value}`);
  }
  lines.push(`"@signature-params": ${entry.input}`);
  return { base: lines.join("\n") };
}

/* ── local keyring ───────────────────────────────────────── */
const verificationKeys = new Map(); // kid → { key: KeyObject, jwk }

function addVerificationKey(jwk) {
  if (!jwk || !jwk.kid) throw new Error("JWK must include a kid");
  let key;
  if (jwk.kty === "oct") {
    if (!jwk.k) throw new Error("oct JWK must include k");
    key = crypto.createSecretKey(Buffer.from(jwk.k, "base64url"));
  } else {
    key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  }
  verificationKeys.set(String(jwk.kid), { key, jwk });
  return true;
}

function loadJwksFile(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = Array.isArray(doc) ? doc : doc.keys || [];
  let n = 0;
  for (const jwk of keys) { try { addVerificationKey(jwk); n++; } catch (_) { /* skip unusable key */ } }
  return n;
}

let jwksMtime = -1;
/* Reload JWKS_PATH when the file changes (mtime-gated so a half-written
   file is retried rather than latched). Called on signed traffic only. */
function ensureJwksFresh() {
  const file = process.env.JWKS_PATH;
  if (!file) return verificationKeys.size;
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs === jwksMtime) return verificationKeys.size;
    const n = loadJwksFile(file);
    jwksMtime = st.mtimeMs;
    return n;
  } catch (_) {
    return verificationKeys.size;
  }
}

/* ── remote JWKS resolution (allowlist-gated background fetcher) ─────
   Default posture is still zero outbound requests: nothing is fetched
   unless the operator sets JWKS_ALLOWLIST. When set, only exact
   https:// origins on that list are contacted, for JWKS documents only:
     - exact origin match (no suffix matching, no redirects)
     - private/loopback/link-local literal addresses refused
     - bounded timeout + response size
     - TTL cache, per-origin rate limit, and exponential backoff
     - optional TLS SPKI pinning (JWKS_PINS) verified before the body
       is parsed or cached — a pin mismatch fails closed
   Fetches run on a background queue (queueJwksFetch) so verification
   never waits on a socket; failed origins are retried with exponential
   backoff + jitter (1 s → 5 min cap). The list is operator-controlled
   configuration, not request-controlled. */
const REMOTE_JWKS_TTL_MS = Number(process.env.JWKS_TTL_MS) || 10 * 60 * 1000;
const REMOTE_JWKS_MAX_BYTES = 64 * 1024;
const REMOTE_JWKS_TIMEOUT_MS = Number(process.env.JWKS_TIMEOUT_MS) || 3000;
const REMOTE_JWKS_MAX_PER_MIN = Number(process.env.JWKS_RATE_LIMIT) || 6;
const REMOTE_JWKS_BACKOFF_BASE_MS = Number(process.env.JWKS_BACKOFF_BASE_MS) || 1000;
const REMOTE_JWKS_BACKOFF_CAP_MS = Number(process.env.JWKS_BACKOFF_CAP_MS) || 5 * 60 * 1000;
const remoteJwksCache = new Map(); // origin → { doc, at, url }
const remoteJwksHits = new Map();  // origin → [timestamps]
const remoteJwksBackoff = new Map(); // origin → { fails, nextAt }

/* Dedicated agent: no connection reuse, no session tickets — every JWKS
   fetch performs a full TLS handshake so the peer certificate (and thus
   the SPKI pin) is always available for inspection. */
const jwksAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

/* Optional operator-supplied CA bundle (PEM) for origins under a private
   PKI. Read once at startup; a missing/unreadable file means system roots
   only. Never attacker-controlled — process configuration like JWKS_PINS. */
let jwksCaPem = null;
if (process.env.JWKS_CA_FILE) {
  try { jwksCaPem = fs.readFileSync(process.env.JWKS_CA_FILE, "utf8"); } catch (_) { jwksCaPem = null; }
}

function jwksAllowlist() {
  return String(process.env.JWKS_ALLOWLIST || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h.includes(":")) return true; // bare IPv6 (includes ::1, fe80::)
  return false;
}

function rateAllows(origin) {
  const now = Date.now();
  const arr = (remoteJwksHits.get(origin) || []).filter((t) => now - t < 60000);
  if (arr.length >= REMOTE_JWKS_MAX_PER_MIN) return false;
  arr.push(now);
  remoteJwksHits.set(origin, arr);
  return true;
}

/* ── exponential backoff (per origin) ─────────────────────── */
/* fails=1 → base, doubling per failure, capped, ±20 % jitter.
   `rand` is injectable so tests can pin the exact delay. */
function jwksBackoffDelay(fails, rand = Math.random) {
  const exp = Math.min(REMOTE_JWKS_BACKOFF_CAP_MS,
    REMOTE_JWKS_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, fails - 1)));
  const jitter = 0.8 + rand() * 0.4; // 80 %–120 %
  return Math.min(REMOTE_JWKS_BACKOFF_CAP_MS, Math.round(exp * jitter));
}

function recordJwksFailure(origin) {
  const prev = remoteJwksBackoff.get(origin) || { fails: 0, nextAt: 0 };
  const fails = prev.fails + 1;
  remoteJwksBackoff.set(origin, { fails, nextAt: Date.now() + jwksBackoffDelay(fails) });
}

function recordJwksSuccess(origin) {
  remoteJwksBackoff.delete(origin);
}

/* ── TLS SPKI pinning (JWKS_PINS, opt-in) ─────────────────── */
/* Format: JWKS_PINS="https://keys.example.com=sha256/<base64>|<hex>,…"
   Multiple pins per origin are separated by "|" (key rollover window).
   Origins without a pin keep standard WebPKI validation only — pinning
   is an *additional* operator-controlled trust anchor, never a bypass. */
function jwksPins() {
  const out = new Map();
  for (const entry of String(process.env.JWKS_PINS || "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const origin = entry.slice(0, eq).trim();
    const pins = entry.slice(eq + 1).split("|")
      .map((p) => p.trim().replace(/^sha256[\/=]/, "")).filter(Boolean);
    if (origin && pins.length) out.set(origin, pins);
  }
  return out;
}

/* sha256 digest over the certificate's SubjectPublicKeyInfo DER. */
function spkiDigest(certRaw) {
  const x = new crypto.X509Certificate(certRaw);
  const der = x.publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest();
}

/* No pin configured for the origin → pass (WebPKI still enforced).
   Pin configured but no peer certificate → fail closed. */
function checkJwksPin(origin, spkiSha256) {
  const pins = jwksPins().get(origin);
  if (!pins) return true;
  if (!spkiSha256) return false;
  const b64 = spkiSha256.toString("base64");
  const hex = spkiSha256.toString("hex");
  return pins.includes(b64) || pins.includes(hex);
}

/* One TLS GET with redirect refusal, size cap, hard timeout, and pin
   verification *before* the body is handed back to the caller. Never
   throws a raw fetch error — rejects with Error("jwks:<reason>"). */
function httpsGetJwks(u) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(val);
    };
    let req;
    try {
      req = https.request(u, {
        method: "GET",
        agent: jwksAgent,
        headers: { accept: "application/json", "user-agent": "aegis-jwks/1.0" },
        timeout: REMOTE_JWKS_TIMEOUT_MS,
        signal: AbortSignal.timeout(REMOTE_JWKS_TIMEOUT_MS),
        ...(jwksCaPem ? { ca: jwksCaPem } : {}),
      }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) { done(new Error("jwks:redirect refused")); res.destroy(); return; }
        if (status !== 200) { done(new Error("jwks:status " + status)); res.destroy(); return; }
        // pin check on the live peer certificate, before any body bytes
        // are accepted — a mismatch tears the socket down immediately
        let spki = null;
        try {
          const cert = res.socket.getPeerCertificate();
          if (cert && cert.raw && cert.raw.length) spki = spkiDigest(cert.raw);
        } catch (_) { spki = null; }
        if (!checkJwksPin(u.origin, spki)) {
          done(new Error("jwks:pin mismatch"));
          req.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > REMOTE_JWKS_MAX_BYTES) { done(new Error("jwks:size cap exceeded")); res.destroy(); return; }
          chunks.push(c);
        });
        res.on("end", () => done(null, { text: Buffer.concat(chunks).toString("utf8"), spki }));
        res.on("error", (e) => done(new Error("jwks:" + (e.message || "socket error"))));
      });
    } catch (e) {
      done(new Error("jwks:" + (e.message || "request build failed")));
      return;
    }
    req.on("timeout", () => { done(new Error("jwks:timeout")); req.destroy(); });
    req.on("error", (e) => {
      // AbortSignal.timeout surfaces as "The operation was aborted" —
      // normalize so operators (and metrics) see the real reason
      const aborted = e && (e.name === "TimeoutError" || e.name === "AbortError");
      done(new Error(aborted ? "jwks:timeout" : "jwks:" + (e.message || "request error")));
    });
    req.end();
  });
}

/* Returns a parsed JWKS document, or null. Never throws. */
async function fetchRemoteJwks(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { counters.jwks.denied++; return null; }
  if (u.protocol !== "https:") { counters.jwks.denied++; return null; }
  if (!jwksAllowlist().includes(u.origin)) { counters.jwks.denied++; return null; } // exact origin, default-deny
  if (isPrivateHost(u.hostname)) { counters.jwks.denied++; return null; }
  const cached = remoteJwksCache.get(u.origin);
  if (cached && Date.now() - cached.at < REMOTE_JWKS_TTL_MS) return cached.doc;
  const bo = remoteJwksBackoff.get(u.origin);
  if (bo && Date.now() < bo.nextAt) {
    counters.jwks.backoff++;
    return cached ? cached.doc : null;                    // in backoff: stale-else-deny, no socket
  }
  if (!rateAllows(u.origin)) {
    counters.jwks.ratelimited++;
    return cached ? cached.doc : null;                    // over limit: reuse, else deny
  }
  try {
    const { text } = await httpsGetJwks(u);
    const doc = JSON.parse(text);
    if (!doc || !Array.isArray(doc.keys)) throw new Error("not a JWKS document");
    remoteJwksCache.set(u.origin, { doc, at: Date.now(), url: rawUrl });
    recordJwksSuccess(u.origin);
    counters.jwks.ok++;
    return doc;
  } catch (_) {
    counters.jwks.error++;
    recordJwksFailure(u.origin);                          // exponential backoff from here
    return cached ? cached.doc : null;                    // stale-if-error
  }
}

/* ── background fetch queue ──────────────────────────────── */
/* Verification signals a missing keyid by enqueuing here; the fetch
   itself happens off the request path, serialized per origin and
   deduplicated so a burst of unknown-kid requests opens one socket. */
const jwksQueue = [];             // raw URLs waiting to be fetched
const jwksQueued = new Set();     // origins queued or in flight
let jwksDraining = false;

function queueJwksFetch(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { return false; }
  if (u.protocol !== "https:") return false;
  if (!jwksAllowlist().includes(u.origin)) return false;  // same gates, before queueing
  if (isPrivateHost(u.hostname)) return false;
  if (jwksQueued.has(u.origin)) return false;             // already queued / in flight
  jwksQueued.add(u.origin);
  jwksQueue.push(rawUrl);
  setImmediate(drainJwksQueue);
  return true;
}

async function drainJwksQueue() {
  if (jwksDraining) return;
  jwksDraining = true;
  try {
    while (jwksQueue.length) {
      const rawUrl = jwksQueue.shift();
      let origin = null;
      try { origin = new URL(rawUrl).origin; } catch (_) { /* skip */ }
      try { const doc = await fetchRemoteJwks(rawUrl); if (doc) loadJwksIntoRing(doc); } catch (_) { /* never throws */ }
      if (origin) jwksQueued.delete(origin);
    }
  } finally {
    jwksDraining = false;
  }
}

/* Periodic background refresher: re-queues every cached origin whose
   document is past half its TTL, so keys rotate without live traffic.
   Timer is unref'd — it never keeps the process (or a test) alive. */
let jwksRefresher = null;
function startJwksRefresher(intervalMs) {
  if (jwksRefresher) return jwksRefresher;
  const iv = intervalMs || Math.max(60000, Math.floor(REMOTE_JWKS_TTL_MS / 2));
  jwksRefresher = setInterval(() => {
    const half = REMOTE_JWKS_TTL_MS / 2;
    for (const entry of remoteJwksCache.values()) {
      if (entry.url && Date.now() - entry.at > half) queueJwksFetch(entry.url);
    }
  }, iv);
  if (typeof jwksRefresher.unref === "function") jwksRefresher.unref();
  return jwksRefresher;
}

function stopJwksRefresher() {
  if (jwksRefresher) clearInterval(jwksRefresher);
  jwksRefresher = null;
}

/* Resolve a keyid that is an https URL, if (and only if) its origin is
   allowlisted. Adds any usable keys to the ring. Returns true on load. */
function loadJwksIntoRing(doc) {
  if (!doc || !Array.isArray(doc.keys)) return 0;
  let n = 0;
  for (const jwk of doc.keys) { try { addVerificationKey(jwk); n++; } catch (_) { /* skip */ } }
  return n;
}

async function ensureRemoteKey(keyid) {
  if (!keyid || typeof keyid !== "string" || !/^https:\/\//.test(keyid)) return false;
  return loadJwksIntoRing(await fetchRemoteJwks(keyid)) > 0;
}

/* Algorithm registry (RFC 9421 §6.2.2 + JOSE aliases for interop). */
const HTTP_SIG_ALGS = {
  "ed25519":           { type: "ed" },
  "EdDSA":             { type: "ed" },
  "eddsa":             { type: "ed" },
  "rsa-pss-sha512":    { type: "rsa-pss", hash: "sha512", salt: 64 },
  "rsa-pss-sha384":    { type: "rsa-pss", hash: "sha384", salt: 48 },
  "rsa-pss-sha256":    { type: "rsa-pss", hash: "sha256", salt: 32 },
  "PS512":             { type: "rsa-pss", hash: "sha512", salt: 64 },
  "PS384":             { type: "rsa-pss", hash: "sha384", salt: 48 },
  "PS256":             { type: "rsa-pss", hash: "sha256", salt: 32 },
  "rsa-v1_5-sha256":   { type: "rsa-pkcs1", hash: "sha256" },
  "RS256":             { type: "rsa-pkcs1", hash: "sha256" },
  "hmac-sha256":       { type: "hmac", hash: "sha256" },
  "HS256":             { type: "hmac", hash: "sha256" },
  "ecdsa-p256-sha256": { type: "ecdsa", hash: "sha256" },
  "ecdsa-p384-sha384": { type: "ecdsa", hash: "sha384" },
  "ES256":             { type: "ecdsa", hash: "sha256" },
  "ES384":             { type: "ecdsa", hash: "sha384" },
};

function algCandidates(paramAlg, jwk) {
  if (paramAlg) return HTTP_SIG_ALGS[paramAlg] ? [paramAlg] : [];
  if (jwk.alg && HTTP_SIG_ALGS[jwk.alg]) return [jwk.alg];
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return ["ed25519"];
  if (jwk.kty === "RSA") return ["rsa-pss-sha512", "rsa-pss-sha256", "rsa-v1_5-sha256"];
  if (jwk.kty === "EC" && jwk.crv === "P-256") return ["ecdsa-p256-sha256"];
  if (jwk.kty === "EC" && jwk.crv === "P-384") return ["ecdsa-p384-sha384"];
  if (jwk.kty === "oct") return ["hmac-sha256"];
  return [];
}

function verifyOne(algName, rec, base, sig) {
  const spec = HTTP_SIG_ALGS[algName];
  if (!spec) return null;
  const data = Buffer.from(base, "utf8");
  try {
    if (spec.type === "ed") return crypto.verify(null, data, rec.key, sig);
    if (spec.type === "rsa-pss")
      return crypto.verify(spec.hash, data, { key: rec.key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: spec.salt }, sig);
    if (spec.type === "rsa-pkcs1")
      return crypto.verify(spec.hash, data, { key: rec.key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    if (spec.type === "ecdsa")
      return crypto.verify(spec.hash, data, { key: rec.key, dsaEncoding: "ieee-p1363" }, sig);
    if (spec.type === "hmac") {
      const mac = crypto.createHmac(spec.hash, rec.key).update(data).digest();
      return mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
    }
  } catch (_) {
    return false;
  }
  return null;
}

/* Full verdict for a request carrying Signature + Signature-Input.
   verdict: "valid" | "invalid" | "unresolved" (key or alg not available). */
function verifySignedRequest(req) {
  const rawIn = req.headers["signature-input"];
  const rawSig = req.headers["signature"];
  if (!rawIn || !rawSig) return { present: false, verdict: "none", reason: "signature headers absent" };
  ensureJwksFresh();
  const preIn = parseSignatureInput(rawIn);
  if (preIn && jwksAllowlist().length) {
    for (const e of preIn) {
      const k = e.params && e.params.keyid;
      if (k && !verificationKeys.has(k)) queueJwksFetch(k); // background warm-up, off the request path
    }
  }
  const entries = preIn;
  if (!entries) return { present: true, verdict: "invalid", reason: "unparseable Signature-Input" };
  const sigs = parseSignatureHeader(rawSig);
  let firstInvalid = null, firstUnresolved = null;
  const bad = (reason) => { if (!firstInvalid) firstInvalid = { reason }; };
  const pend = (reason) => { if (!firstUnresolved) firstUnresolved = { reason }; };

  for (const entry of entries) {
    const b64 = sigs[entry.label];
    if (b64 === undefined) { bad(`no signature bytes for label "${entry.label}"`); continue; }
    if (!/^[A-Za-z0-9+/=_-]*$/.test(b64)) { bad("signature bytes are not valid base64"); continue; }
    const sig = Buffer.from(b64, "base64");
    if (!sig.length) { bad("signature bytes are empty"); continue; }
    const covered = new Set(entry.components.map((c) => (c.name.startsWith(":") ? "@" + c.name.slice(1) : c.name)));
    const missing = REQUIRED_COMPONENTS.filter((rc) => !covered.has(rc));
    if (missing.length) { bad(`insufficient coverage — missing ${missing.join(" ")}`); continue; }
    const nowS = Math.floor(Date.now() / 1000);
    const created = entry.params.created !== undefined ? Number(entry.params.created) : null;
    const expires = entry.params.expires !== undefined ? Number(entry.params.expires) : null;
    if (created !== null && !Number.isFinite(created)) { bad("malformed created parameter"); continue; }
    if (expires !== null && !Number.isFinite(expires)) { bad("malformed expires parameter"); continue; }
    if (expires !== null && nowS > expires + 120) { bad("signature expired (outside the ±120 s freshness window)"); continue; }
    if (created !== null && nowS < created - 120) { bad("signature created in the future (outside the ±120 s freshness window)"); continue; }
    const baseRes = signatureBase(req, entry);
    if (baseRes.error) { bad(baseRes.error); continue; }
    const kid = entry.params.keyid;
    let rec = kid ? verificationKeys.get(kid) : null;
    if (!rec && kid && jwksAllowlist().length) {
      // sync fast-path: keys fetched by the background queue are attached
      // as soon as its fetch resolves; a miss here stays unresolved for
      // this request and is retried automatically on the next one.
      rec = verificationKeys.get(kid);
    }
    if (!rec) {
      pend(kid ? `key "${kid}" not in the local keyring (set JWKS_PATH, JWKS_ALLOWLIST, or add keys)` : "no keyid parameter and no key registered");
      continue;
    }
    const cands = algCandidates(entry.params.alg, rec.jwk);
    if (!cands.length) { pend(`unsupported algorithm "${entry.params.alg}"`); continue; }
    let ok = false, sawUnsupported = false;
    for (const alg of cands) {
      const r = verifyOne(alg, rec, baseRes.base, sig);
      if (r === null) { sawUnsupported = true; continue; }
      if (r === true) {
        return { present: true, verdict: "valid", reason: `${alg} signature verified over RFC 9421 base`, label: entry.label, keyid: kid || null, alg };
      }
    }
    if (sawUnsupported && cands.length === 1) pend(`unsupported algorithm "${cands[0]}"`);
    else bad(`signature check failed (${cands.join(" / ")})`);
  }
  if (firstInvalid) return { present: true, verdict: "invalid", reason: firstInvalid.reason };
  if (firstUnresolved) return { present: true, verdict: "unresolved", reason: firstUnresolved.reason };
  return { present: true, verdict: "invalid", reason: "nothing verifiable in Signature-Input" };
}

/* ── counters ───────────────────────────────────────────── */
/* Latency histogram buckets in seconds (Prometheus `le` boundaries).
   Request duration is recorded in emit() from the real measured ms. */
const LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const counters = {
  since: Date.now(),
  total: 0,
  byKind: { signed: 0, known: 0, shadow: 0, tool: 0, human: 0 },
  byVerdict: { valid: 0, invalid: 0, unresolved: 0 },
  byAgent: {},
  byPath: {},
  recent: [], // timestamps for rate
  signals: { ipi: 0, trajad: 0, toolCalls: 0, revenue: 0 },
  jwks: { ok: 0, denied: 0, ratelimited: 0, backoff: 0, error: 0 }, // remote key fetches by result
  latency: { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 },
};

function resetCounters() {
  counters.since = Date.now();
  counters.total = 0;
  counters.byKind = { signed: 0, known: 0, shadow: 0, tool: 0, human: 0 };
  counters.byVerdict = { valid: 0, invalid: 0, unresolved: 0 };
  counters.byAgent = {};
  counters.byPath = {};
  counters.recent = [];
  counters.signals = { ipi: 0, trajad: 0, toolCalls: 0, revenue: 0 };
  counters.jwks = { ok: 0, denied: 0, ratelimited: 0, backoff: 0, error: 0 };
  counters.latency = { buckets: LATENCY_BUCKETS.map(() => 0), sum: 0, count: 0 };
}
function bump(map, key) { map[key] = (map[key] || 0) + 1; }
function eventsPerMin() {
  const cutoff = Date.now() - 60000;
  counters.recent = counters.recent.filter((t) => t > cutoff);
  return counters.recent.length;
}
function snapshot() {
  const topAgents = Object.entries(counters.byAgent).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return {
    type: "snapshot",
    since: counters.since,
    total: counters.total,
    byKind: { ...counters.byKind },
    byVerdict: { ...counters.byVerdict },
    byAgent: Object.fromEntries(topAgents),
    topAgents,
    byPath: { ...counters.byPath },
    eventsPerMin: eventsPerMin(),
    signals: { ...counters.signals },
  };
}

/* ── Prometheus text exposition (/metrics, format 0.0.4) ── */
/* Label values are escaped per the exposition format: backslash,
   double-quote, and newline. HELP text needs the same escaping. */
function promEsc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderMetrics() {
  const L = [];
  const metric = (name, help, type, lines) => {
    L.push(`# HELP ${name} ${help}`);
    L.push(`# TYPE ${name} ${type}`);
    for (const line of lines) L.push(line);
  };

  metric("aegis_events_total", "Classified telemetry events by kind.", "counter",
    Object.entries(counters.byKind).map(([k, v]) => `aegis_events_total{kind="${promEsc(k)}"} ${v}`));

  metric("aegis_verifications_total", "RFC 9421 signature verification outcomes by verdict.", "counter",
    Object.entries(counters.byVerdict).map(([k, v]) => `aegis_verifications_total{verdict="${promEsc(k)}"} ${v}`));

  metric("aegis_agent_requests_total", "Requests attributed to a known agent.", "counter",
    Object.entries(counters.byAgent).map(([k, v]) => `aegis_agent_requests_total{agent="${promEsc(k)}"} ${v}`));

  metric("aegis_signals_total", "Derived risk-signal counts (IPI, trajectory anomaly, tool calls).", "counter",
    [
      `aegis_signals_total{signal="ipi"} ${counters.signals.ipi}`,
      `aegis_signals_total{signal="trajad"} ${counters.signals.trajad}`,
      `aegis_signals_total{signal="tool_call"} ${counters.signals.toolCalls}`,
    ]);

  const buckets = counters.latency.buckets;
  const bucketLines = LATENCY_BUCKETS.map((le, i) =>
    `aegis_request_duration_seconds_bucket{le="${le}"} ${buckets[i]}`);
  bucketLines.push(`aegis_request_duration_seconds_bucket{le="+Inf"} ${counters.latency.count}`);
  bucketLines.push(`aegis_request_duration_seconds_sum ${counters.latency.sum.toFixed(6)}`);
  bucketLines.push(`aegis_request_duration_seconds_count ${counters.latency.count}`);
  metric("aegis_request_duration_seconds", "Request handling latency in seconds.", "histogram", bucketLines);

  metric("aegis_jwks_fetches_total", "Remote JWKS fetch attempts by result.", "counter",
    Object.entries(counters.jwks).map(([k, v]) => `aegis_jwks_fetches_total{result="${promEsc(k)}"} ${v}`));

  metric("aegis_events_per_minute", "Events observed in the trailing 60 s window.", "gauge",
    [`aegis_events_per_minute ${eventsPerMin()}`]);

  metric("aegis_sse_clients", "Open SSE dashboard connections.", "gauge",
    [`aegis_sse_clients ${clients.size}`]);

  metric("aegis_uptime_seconds", "Seconds since the counter epoch (reset on resetCounters).", "gauge",
    [`aegis_uptime_seconds ${((Date.now() - counters.since) / 1000).toFixed(3)}`]);

  return L.join("\n") + "\n";
}

/* ── SSE ────────────────────────────────────────────────── */
const clients = new Set();
function broadcast(obj) {
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of clients) {
    try { res.write(line); } catch (_) { clients.delete(res); }
  }
}

function emit(ev) {
  counters.total++;
  counters.recent.push(ev.t);
  bump(counters.byKind, ev.kind);
  // latency histogram (seconds), cumulative buckets as Prometheus expects
  const sec = (Number(ev.ms) || 0) / 1000;
  counters.latency.count++;
  counters.latency.sum += sec;
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (sec <= LATENCY_BUCKETS[i]) counters.latency.buckets[i]++;
  }
  if (ev.signed && ev.signed.verdict && ev.signed.verdict !== "none") bump(counters.byVerdict, ev.signed.verdict);
  if (ev.kind === "known" || ev.kind === "signed") bump(counters.byAgent, ev.agent.name);
  bump(counters.byPath, ev.path);
  const sg = ev.signals;
  if (sg) {
    if (sg.ipi) counters.signals.ipi++;
    if (sg.trajad) counters.signals.trajad++;
    if (sg.toolCall) counters.signals.toolCalls++;
    if (sg.revenue) counters.signals.revenue += sg.revenue;
  }
  broadcast(ev);
}

function makeEvent(req, status, ms) {
  const cls = classify(req);
  const signed = cls.signed.present
    ? { ...cls.signed, ...verifySignedRequest(req), present: true }
    : cls.signed;
  const url = new URL(req.url, "http://local");
  const ev = {
    t: Date.now(),
    source: "http",
    method: req.method,
    path: url.pathname,
    status,
    ms,
    ip: (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().replace("::ffff:", ""),
    ua: (req.headers["user-agent"] || "").slice(0, 220),
    lang: req.headers["accept-language"] || null,
    ref: req.headers.referer || req.headers.referrer || null,
    kind: cls.kind,
    agent: cls.agent,
    signed,
    shadow: cls.shadow,
    headers: cls.headers,
  };
  ev.signals = deriveSignals(ev, url);
  return ev;
}

/* ── real signals for the secondary panels (04–09) ──────────────────
   Panels that were previously simulated now consume flags derived from
   the actual request: injection-shaped payloads → IPI, out-of-scope or
   evasive trajectory → TrajAD anomaly, tool/agent traffic → MCP ledger,
   verified signed crawls → pay-per-crawl revenue. */
const IPI_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s*[-_]?prompt/i,
  /you\s+are\s+now\s+(a|an)\b/i,
  /transfer\s+[\d.]+\s*(eth|btc|usd)/i,
  /bcc\s*[:=]/i,
  /(?:\.\.?[\\/]){2,}/,                 // path traversal
  /<\s*script|javascript:/i,
  /exfiltrate|dump(?:ed)?[_-]?(?:secrets|keys|tokens)/i,
  /(?:^|[^a-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?:[^a-z0-9+/=]|$)/, // long opaque blob
  /--[a-z-]*\s*(?:no-preserve-root|drop-table)/i,
];
const TRAJAD_SCOPE = /^\/(?:api|docs|products|pricing|blog|robots\.txt|\.well-known|index\.html|\?|$)/i;

function deriveSignals(ev, url) {
  const s = { ipi: null, trajad: null, toolCall: false, revenue: 0 };
  const probe = decodeURIComponent(
    ((ev.path || "") + "?" + (url.search || "")).replace(/\+/g, " ")
  ).slice(0, 1400);

  // IPI: injection-shaped payload anywhere in path or query
  for (const re of IPI_PATTERNS) {
    const m = re.exec(probe);
    if (m) {
      s.ipi = { vector: "indirect prompt injection", snippet: m[0].slice(0, 90), action: "BLOCKED" };
      break;
    }
  }

  // TrajAD: evasive or out-of-scope trajectory
  if (ev.kind === "shadow" && ev.shadow && ev.shadow.conf >= 90) {
    s.trajad = `evasive trajectory (${ev.shadow.signal}) — HALTED before step`;
  } else if (!TRAJAD_SCOPE.test(ev.path || "") && ev.kind !== "known" && ev.kind !== "signed") {
    s.trajad = `destination ${ev.path} not in mission scope — ROLLBACK queued`;
  }

  // WebMCP ledger: real tool/agent traffic
  s.toolCall = ev.kind === "tool" || (ev.kind === "signed" && (ev.path || "").startsWith("/api/"));

  // Pay-per-crawl: only verified signed crawls earn
  if (ev.signed && ev.signed.verdict === "valid") s.revenue = 0.0042;
  return s;
}

/* ── static files (whitelisted) ─────────────────────────── */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const STATIC_FILES = new Set(["index.html", "styles.css", "app.js", "build.js", "server.js"]);

/* ── HTTP server ────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, "http://local");
  const pathname = url.pathname;

  const finish = (status) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (!TELEMETRY_PATHS.has(pathname)) emit(makeEvent(req, status, ms));
  };

  if (pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, total: counters.total }));
    finish(200);
    return;
  }

  if (pathname === "/api/snapshot") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(snapshot()));
    finish(200);
    return;
  }

  if (pathname === "/metrics") {
    // Prometheus text exposition format 0.0.4 — telemetry path, not counted
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderMetrics());
    finish(200);
    return;
  }

  if (pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write("retry: 2000\n");
    res.write("data: " + JSON.stringify(snapshot()) + "\n\n"); // hydrate on connect
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return; // telemetry path: not counted
  }

  // static
  let file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!STATIC_FILES.has(file) || file.includes("..")) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    finish(404);
    return;
  }
  const full = path.join(ROOT, file);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404); res.end("not found"); finish(404); return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(full)] || "application/octet-stream" });
    res.end(data);
    finish(200);
  });
});

const TELEMETRY_PATHS = new Set(["/events", "/api/snapshot", "/api/health", "/metrics"]);

/* heartbeat so proxies/browsers keep SSE open — only when run as a server */
if (require.main === module) {
  setInterval(() => {
    for (const res of clients) { try { res.write(": hb\n\n"); } catch (_) { clients.delete(res); } }
  }, 15000);
}

/* ── optional access-log tail ───────────────────────────── */
/* Supports:
 *   - JSON lines: {"ts":...,"ip":...,"method":...,"path":...,"status":200,"ua":"..."}
 *   - nginx/apache combined:
 *     1.2.3.4 - - [03/Oct/2026:17:20:00 +0000] "GET /x HTTP/1.1" 200 123 "-" "UA"
 */
const NGINX_RE = /^(\S+) \S+ \S+ \[[^\]]+\] "(\S+) (\S+)[^"]*" (\d{3}) \d+ "([^"]*)" "([^"]*)"/;

function parseLogLine(line) {
  line = line.trim();
  if (!line) return null;
  if (line.startsWith("{")) {
    try {
      const j = JSON.parse(line);
      const ua = j.ua || j.user_agent || j["user-agent"] || "";
      const fakeReq = {
        headers: {
          "user-agent": ua,
          "signature-input": j["signature-input"] || j.signature_input,
          signature: j.signature,
          "signature-agent": j["signature-agent"] || j.signature_agent,
          "accept-language": j.lang || j["accept-language"],
          "sec-ch-ua": j["sec-ch-ua"],
          "sec-fetch-mode": j["sec-fetch-mode"],
          host: j.host || j.authority || undefined,
          referer: j.ref || j.referer,
        },
        socket: { remoteAddress: j.ip || j.remote_addr || "-" },
        method: (j.method || "GET").toUpperCase(),
        url: j.path || j.url || "/",
        headers_: null,
      };
      const cls = classify(fakeReq, "log");
      const signed = cls.signed.present
        ? { ...cls.signed, ...verifySignedRequest(fakeReq), present: true }
        : cls.signed;
      const pathname = String(j.path || j.url || "/").split("?")[0];
      return {
        t: j.t || j.ts || Date.now(),
        source: "log",
        method: fakeReq.method,
        path: pathname,
        status: Number(j.status || j.status_code || 200),
        ms: Number(j.ms || j.request_time || 0),
        ip: String(j.ip || j.remote_addr || "-"),
        ua: String(ua).slice(0, 220),
        lang: j.lang || null,
        ref: j.ref || j.referer || null,
        kind: cls.kind,
        agent: cls.agent,
        signed,
        shadow: cls.shadow,
        headers: cls.headers,
      };
    } catch (_) { return null; }
  }
  const m = NGINX_RE.exec(line);
  if (!m) return null;
  const [, ip, method, rawPath, status, ref, uaRaw] = m;
  const ua = uaRaw === "-" ? "" : uaRaw;
  const fakeReq = {
    headers: {
      "user-agent": ua,
      referer: ref === "-" ? undefined : ref,
    },
    socket: { remoteAddress: ip },
    method: method.toUpperCase(),
    url: rawPath,
  };
  const cls = classify(fakeReq, "log");
  return {
    t: Date.now(),
    source: "log",
    method: method.toUpperCase(),
    path: rawPath.split("?")[0],
    status: Number(status),
    ms: 0,
    ip,
    ua: ua.slice(0, 220),
    lang: null,
    ref: ref === "-" ? null : ref,
    kind: cls.kind,
    agent: cls.agent,
    signed: cls.signed,
    shadow: cls.shadow,
    headers: cls.headers,
  };
}

let logWatcher = null;
if (require.main === module && LOG_PATH) {
  const init = () => {
    if (!fs.existsSync(LOG_PATH)) { console.log(`[log] ${LOG_PATH} not found — will keep checking`); return; }
    let pos = fs.statSync(LOG_PATH).size; // tail only NEW lines
    logWatcher = fs.watchFile(LOG_PATH, { interval: 1000 }, () => {
      try {
        const st = fs.statSync(LOG_PATH);
        if (st.size < pos) pos = 0; // truncated
        if (st.size === pos) return;
        const fd = fs.openSync(LOG_PATH, "r");
        const buf = Buffer.alloc(st.size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = st.size;
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          const ev = parseLogLine(line);
          if (ev) emit(ev);
        }
      } catch (e) { console.error("[log] read error:", e.message); }
    });
    console.log(`[log] tailing ${LOG_PATH} from byte ${pos}`);
  };
  init();
  if (!fs.existsSync(LOG_PATH)) {
    const iv = setInterval(() => { if (fs.existsSync(LOG_PATH)) { clearInterval(iv); init(); } }, 1000);
  }
}

/* Only start the HTTP server / log tail when executed directly.
   Tests require() this module for its pure functions (classify, parseLogLine). */
if (require.main === module) {
  if (process.env.JWKS_PATH) {
    ensureJwksFresh();
    console.log(`[keys] JWKS keyring: ${process.env.JWKS_PATH} → ${verificationKeys.size} key(s)`);
  }
  if (jwksAllowlist().length) {
    startJwksRefresher();
    console.log(`[keys] remote JWKS allowlist: ${jwksAllowlist().join(", ")} (background refresher on)`);
    if (jwksPins().size) console.log(`[keys] TLS SPKI pins configured for ${jwksPins().size} origin(s)`);
  }
  server.listen(PORT, HOST, () => {
    console.log(`AEGIS capture server → http://${HOST}:${PORT}`);
    console.log(`  SSE stream:   http://${HOST}:${PORT}/events`);
    console.log(`  snapshot:     http://${HOST}:${PORT}/api/snapshot`);
    console.log(`  log tail:     ${LOG_PATH || "(disabled — set LOG_PATH to tail an access log)"}`);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`port ${PORT} in use — set PORT=<other> and retry`);
      process.exit(2);
    }
    throw e;
  });
}

/* exported for the test suite */
module.exports = { classify, parseLogLine,
  NGINX_RE, counters, snapshot, resetCounters, renderMetrics, LATENCY_BUCKETS,
  signatureBase, addVerificationKey, loadJwksFile, server,
  verifySignedRequest, parseSignatureInput, parseSignatureHeader,
  fetchRemoteJwks, ensureRemoteKey, isPrivateHost, jwksAllowlist,
  queueJwksFetch, jwksBackoffDelay, recordJwksFailure, recordJwksSuccess,
  jwksPins, checkJwksPin, startJwksRefresher, stopJwksRefresher,
  remoteJwksCache, remoteJwksBackoff, httpsGetJwks, jwksQueued,
};
