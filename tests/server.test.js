"use strict";
/* Classification + log-parsing tests for the AEGIS capture server.
 * Includes regression tests for two bugs found during integration:
 *   1. curl/scripted clients were misrouted to the shadow track
 *   2. access-log lines tripped the client-hint heuristic (logs don't
 *      record those headers — their absence there is not evidence)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classify, parseLogLine } = require("../server.js");

const req = (ua, headers = {}) => ({
  headers: { "user-agent": ua, ...headers },
  socket: { remoteAddress: "203.0.113.9" },
  method: "GET",
  url: "/",
});

/* ── live-socket classification ─────────────────────────── */

test("signed requests (RFC 9421 Web Bot Auth) are classified as signed", () => {
  const c = classify(
    req("Mozilla/5.0 (compatible; TestAgent/1.0)", {
      "signature-input": '(:method/:authority/:path);created=1;expires=2;tag="web-bot-auth"',
      signature: "c2lnbmF0dXJl",
      "signature-agent": "https://example.ai/.well-known/sig#:keyid=1",
      "content-digest": "sha-256=:abc:",
    })
  );
  assert.equal(c.kind, "signed");
  assert.equal(c.signed.present, true);
  assert.match(c.signed.input, /web-bot-auth/);
  assert.equal(c.headers["signature-agent"], "https://example.ai/.well-known/sig#:keyid=1");
});

test("known agent UAs map to their operator", () => {
  const cases = [
    ["Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot", "OpenAI"],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0)", "ClaudeBot", "Anthropic"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0)", "PerplexityBot", "Perplexity"],
    ["Mozilla/5.0 (compatible; Google-Extended)", "Google-Extended", "Google"],
    ["Mozilla/5.0 (compatible; CCBot/1.0)", "CCBot", "Common Crawl"],
  ];
  for (const [ua, name, op] of cases) {
    const c = classify(req(ua));
    assert.equal(c.kind, "known", ua);
    assert.equal(c.agent.name, name);
    assert.equal(c.agent.op, op);
  }
});

test("headless/automation browsers are shadow with high confidence", () => {
  const c = classify(
    req("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36")
  );
  assert.equal(c.kind, "shadow");
  assert.ok(c.shadow.conf >= 90, `conf ${c.shadow.conf} >= 90 expected`);
  const pw = classify(req("Mozilla/5.0 Playwright/1.48"));
  assert.equal(pw.kind, "shadow");
});

test("regression: curl and library clients are tool traffic, never shadow", () => {
  for (const ua of ["curl/8.5.0", "python-requests/2.31.0", "Go-http-client/2.0", "Wget/1.21"]) {
    assert.equal(classify(req(ua)).kind, "tool", ua);
  }
});

test("regression: browser-claim heuristic applies only to live sockets", () => {
  // unknown Mozilla-claiming UA with no client-hint/language headers
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WeirdBrowser/1.0";
  assert.equal(classify(req(ua), "http").kind, "shadow", "live socket → shadow");
  assert.equal(classify(req(ua), "log").kind, "human", "log line → headers unobservable → not shadow");
});

test("missing User-Agent is shadow", () => {
  const c = classify(req(""));
  assert.equal(c.kind, "shadow");
  assert.match(c.shadow.signal, /missing User-Agent/);
});

test("ordinary browser with client hints is human", () => {
  const c = classify(
    req("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", {
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Chromium";v="131"',
      "sec-fetch-mode": "navigate",
    })
  );
  assert.equal(c.kind, "human");
});

/* ── access-log parsing ─────────────────────────────────── */

test("parses nginx combined-format lines", () => {
  const line =
    '203.0.113.42 - - [03/Oct/2026:18:20:00 +0000] "GET /blog/x.html HTTP/1.1" 200 54312 "-" "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"';
  const ev = parseLogLine(line);
  assert.ok(ev, "line should parse");
  assert.equal(ev.ip, "203.0.113.42");
  assert.equal(ev.method, "GET");
  assert.equal(ev.path, "/blog/x.html");
  assert.equal(ev.status, 200);
  assert.equal(ev.source, "log");
  assert.equal(ev.kind, "known");
  assert.equal(ev.agent.name, "GPTBot");
});

test("parses JSON log lines", () => {
  const ev = parseLogLine(
    JSON.stringify({
      ip: "198.51.100.7",
      method: "GET",
      path: "/wp-admin/setup.php",
      status: 403,
      ua: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0",
    })
  );
  assert.ok(ev);
  assert.equal(ev.kind, "shadow");
  assert.equal(ev.status, 403);
  assert.equal(ev.path, "/wp-admin/setup.php");
  assert.equal(ev.source, "log");
});

test('nginx "-" UA counts as missing UA (shadow)', () => {
  const ev = parseLogLine('10.0.0.1 - - [03/Oct/2026:18:20:00 +0000] "GET / HTTP/1.1" 200 100 "-" "-"');
  assert.ok(ev);
  assert.equal(ev.kind, "shadow");
});

test("malformed lines are ignored, not thrown", () => {
  assert.equal(parseLogLine("not a log line at all"), null);
  assert.equal(parseLogLine("{broken json"), null);
  assert.equal(parseLogLine(""), null);
  assert.equal(parseLogLine("   "), null);
});
