/* server.js — AEGIS capture server (zero dependencies, Node stdlib)
 *
 * Serves the dashboard and observes REAL HTTP telemetry:
 *   GET /              → index.html (self-contained dashboard)
 *   GET /events        → Server-Sent Events stream of classified requests
 *   GET /api/snapshot  → aggregate counters (JSON)
 *   GET /api/health    → readiness probe
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
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8788;
const HOST = "127.0.0.1";
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

/* ── counters ───────────────────────────────────────────── */
const counters = {
  since: Date.now(),
  total: 0,
  byKind: { signed: 0, known: 0, shadow: 0, tool: 0, human: 0 },
  byAgent: {},
  byPath: {},
  recent: [], // timestamps for rate
};
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
    byAgent: Object.fromEntries(topAgents),
    topAgents,
    byPath: { ...counters.byPath },
    eventsPerMin: eventsPerMin(),
  };
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
  if (ev.kind === "known" || ev.kind === "signed") bump(counters.byAgent, ev.agent.name);
  bump(counters.byPath, ev.path);
  broadcast(ev);
}

function makeEvent(req, status, ms) {
  const cls = classify(req);
  const url = new URL(req.url, "http://local");
  return {
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
    signed: cls.signed,
    shadow: cls.shadow,
    headers: cls.headers,
  };
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

const TELEMETRY_PATHS = new Set(["/events", "/api/snapshot", "/api/health"]);

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
          referer: j.ref || j.referer,
        },
        socket: { remoteAddress: j.ip || j.remote_addr || "-" },
        method: (j.method || "GET").toUpperCase(),
        url: j.path || j.url || "/",
        headers_: null,
      };
      const cls = classify(fakeReq, "log");
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
        signed: cls.signed,
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
module.exports = { classify, parseLogLine, NGINX_RE, counters, snapshot };
