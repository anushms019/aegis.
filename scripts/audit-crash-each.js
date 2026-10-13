"use strict";
/* Phase 0 audit (c): per-case crash battery.
   Each case is sent to a FRESH server process (a crash kills it), then we
   check whether the process survived and what HTTP status came back.
   Usage: node scripts/audit-crash-each.js [pathToServer.js] */
const net = require("net");
const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.resolve(process.argv[2] || "server.js");
const PORT = 8801;

const cases = [
  ["GET /% HTTP/1.1", "GET /%"],
  ["GET /%E0%A4%A HTTP/1.1", "GET /%E0%A4%A"],
  ["GET /?q=% HTTP/1.1", "GET /?q=%"],
  ["GET /" + "a".repeat(10240) + " HTTP/1.1", "10 KB path"],
  ["GET / HTTP/1.1\r\nX-Bad: \xff\xfe\xfd", "invalid UTF-8 header"],
  [
    "GET / HTTP/1.1\r\nSignature: sig1=:!!!not-base64!!!:\r\nSignature-Input: sig1=(:method)",
    "malformed Signature/Signature-Input",
  ],
  ["GET / HTTP/1.1\r\nAuthorization: Basic !!!", "Authorization: Basic !!!"],
  ["GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1", "encoded traversal"],
  ["GET /?q=<script>alert(1)</script> HTTP/1.1", "xss query"],
  ["GET /?q=%ZZ HTTP/1.1", "%ZZ invalid escape"],
  ["GET /?q=%E0%A4 HTTP/1.1", "truncated multibyte escape"],
  ["GET /api?path=% HTTP/1.1", "scope path with bare %"],
  ["G\x00T / HTTP/1.1", "NUL byte in method"],
  ["GET /?q=%25% HTTP/1.1", "%25 then bare %"],
  // absolute-form / malformed request targets: Node's parser accepts them,
  // WHATWG URL does not — the handler's `new URL(req.url)` used to throw
  ["GET http:// HTTP/1.1", "absolute-form unparseable target"],
  ["GET /// HTTP/1.1", "protocol-relative target"],
  ["GET http://[ HTTP/1.1", "broken authority target"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), JWKS_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, getLog: () => log };
}

function raw(payload) {
  return new Promise((resolve) => {
    let out = "";
    const sock = net.connect(PORT, "127.0.0.1", () =>
      sock.write(payload + "\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
    );
    sock.setTimeout(3000);
    sock.on("data", (d) => (out += d.toString("latin1")));
    sock.on("timeout", () => sock.destroy());
    sock.on("error", () => {});
    sock.on("close", () => resolve(out));
  });
}

function health() {
  return new Promise((resolve) => {
    let out = "";
    const sock = net.connect(PORT, "127.0.0.1", () =>
      sock.write("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
    );
    sock.setTimeout(3000);
    sock.on("data", (d) => (out += d.toString("latin1")));
    sock.on("timeout", () => sock.destroy());
    sock.on("error", () => resolve(null));
    sock.on("close", () => resolve(out));
  });
}

(async () => {
  const results = [];
  for (const [payload, label] of cases) {
    const { child, getLog } = start();
    // wait for listen
    let up = false;
    for (let i = 0; i < 40; i++) {
      const h = await health();
      if (h && h.includes("200 OK")) { up = true; break; }
      await sleep(100);
    }
    if (!up) { results.push([label, "SERVER_DID_NOT_START", "-", getLog().slice(0, 200)]); child.kill(); continue; }
    const out = await raw(payload);
    await sleep(250);
    const alive = await health();
    const survived = !!(alive && alive.includes("200 OK"));
    const status =
      (out.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] ||
      (out === "" ? "NO_RESPONSE" : "OTHER");
    const err = (getLog().match(/(URIError|TypeError|SyntaxError|Error)[^\n]*/) || [])[1] || "";
    results.push([label, survived ? "SURVIVED" : "CRASHED", status, err]);
    try { child.kill("SIGKILL"); } catch (_) {}
    await sleep(120);
  }
  console.log("CASE | RESULT | HTTP | ERROR");
  for (const r of results) console.log(r.join(" | "));
  const crashed = results.filter((r) => r[1] === "CRASHED").length;
  console.log(`\n${results.length - crashed}/${results.length} survived, ${crashed} crashed`);
  process.exit(0);
})();
