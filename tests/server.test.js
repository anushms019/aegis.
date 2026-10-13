"use strict";
/* Classification + log-parsing tests for the AEGIS capture server.
 * Includes regression tests for two bugs found during integration:
 *   1. curl/scripted clients were misrouted to the shadow track
 *   2. access-log lines tripped the client-hint heuristic (logs don't
 *      record those headers — their absence there is not evidence)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
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

/* ── fatal-error policy (audit finding C4 / task P1-1) ─────────
   Outside the test runner a fatal error must be logged and the process
   must exit non-zero: a capture server that can no longer capture may not
   keep serving. Under `node --test` the server installs no handlers at all
   (the runner owns fatal errors), asserted below by the absence of the
   marker — nothing is ever swallowed silently in either mode. Each case
   runs in its own child process so neither outcome can take this suite
   down. */
const serverPath = path.join(__dirname, "..", "server.js");

function runFatal(trigger, { underTestRunner = false } = {}) {
  const env = { ...process.env };
  if (underTestRunner) env.NODE_TEST_CONTEXT = "child-v8";
  else delete env.NODE_TEST_CONTEXT; // a normal production run
  return spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(serverPath)}); ${trigger}`],
    { env, encoding: "utf8", timeout: 15000 }
  );
}

test("uncaughtException outside tests is logged and exits non-zero", () => {
  const child = runFatal("setTimeout(() => { throw new Error('boom'); }, 20);");
  assert.notEqual(child.status, 0, `expected a non-zero exit, got ${child.status}\n${child.stderr}`);
  assert.match(child.stderr, /\[fatal\] uncaughtException/);
  assert.match(child.stderr, /boom/);
});

test("unhandledRejection outside tests is logged and exits non-zero", () => {
  const child = runFatal("Promise.reject(new Error('nope'));");
  assert.notEqual(child.status, 0, `expected a non-zero exit, got ${child.status}\n${child.stderr}`);
  assert.match(child.stderr, /\[fatal\] unhandledRejection/);
  assert.match(child.stderr, /nope/);
});

test("no server fatal handlers are installed under the test runner", () => {
  const child = runFatal("setTimeout(() => { throw new Error('boom'); }, 20);", { underTestRunner: true });
  assert.notEqual(child.status, 0, "Node's default (crash, non-zero) must still apply");
  assert.ok(!/\[fatal\]/.test(child.stderr),
    "server.js must leave fatal errors to the test runner");
});

/* ── exposure policy (task P2-1) ────────────────────────────
   A non-loopback bind with no credentials must refuse to start; loopback,
   an explicit AEGIS_ALLOW_INSECURE=1, or a configured AEGIS_AUTH_USERS
   must all start normally. Each case is a real child process, because the
   refusal happens on the execution path only (requiring the module must
   never enforce it). */

function serverEnv(overrides) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;   // run exactly as an operator would
  delete env.AEGIS_AUTH_USERS;    // no credentials unless a case says so
  delete env.AEGIS_ALLOW_INSECURE;
  delete env.OTLP_ENDPOINT;
  delete env.JWKS_PATH;
  return { ...env, ...overrides };
}

function startServer(overrides) {
  const child = spawn(process.execPath, [serverPath], {
    env: serverEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));
  return { child, output: () => out, exited };
}

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitForOutput(srv, re, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (re.test(srv.output())) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return re.test(srv.output());
}

/* Bounded wait for an exit: a missing refusal must fail the assertion, not
   hang the suite (the test runner has no default timeout). */
async function exitCode(srv, ms = 10000) {
  const code = await Promise.race([
    srv.exited,
    new Promise((r) => setTimeout(() => r(undefined), ms)),
  ]);
  if (code === undefined) srv.child.kill();
  return code;
}

test("non-loopback bind without credentials refuses to start", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.7.7"]) {
    const srv = startServer({ HOST: host, PORT: String(await freePort()) });
    const code = await exitCode(srv);
    assert.ok(code !== undefined,
      `HOST=${host} never exited — refusal is missing? ${srv.output()}`);
    assert.notEqual(code, 0, `HOST=${host} must exit non-zero, output: ${srv.output()}`);
    assert.match(srv.output(), /refusing to bind/, `HOST=${host}: wrong message: ${srv.output()}`);
    assert.match(srv.output(), /AEGIS_ALLOW_INSECURE/, `HOST=${host}: must name the escape hatch`);
    assert.ok(!/AEGIS capture server/.test(srv.output()), `HOST=${host} must not listen`);
  }
});

test("loopback bind starts without credentials (safe default unchanged)", async () => {
  const srv = startServer({ HOST: "127.0.0.1", PORT: String(await freePort()) });
  assert.ok(await waitForOutput(srv, /AEGIS capture server/),
    `loopback should start: ${srv.output()}`);
  srv.child.kill();
  await srv.exited;
});

test("non-loopback bind with AEGIS_AUTH_USERS configured starts", async () => {
  const srv = startServer({
    HOST: "0.0.0.0",
    PORT: String(await freePort()),
    AEGIS_AUTH_USERS: "ops:pw123:admin,dash:vw123:viewer",
  });
  assert.ok(await waitForOutput(srv, /AEGIS capture server/),
    `auth-configured bind should start: ${srv.output()}`);
  assert.match(srv.output(), /\[auth\] enabled/);
  srv.child.kill();
  await srv.exited;
});

test("AEGIS_ALLOW_INSECURE=1 is an explicit opt-in that still starts", async () => {
  const srv = startServer({
    HOST: "0.0.0.0",
    PORT: String(await freePort()),
    AEGIS_ALLOW_INSECURE: "1",
  });
  assert.ok(await waitForOutput(srv, /AEGIS capture server/),
    `explicit opt-in should start: ${srv.output()}`);
  assert.match(srv.output(), /\[auth\] disabled/);
  srv.child.kill();
  await srv.exited;
});
