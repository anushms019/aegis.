"use strict";
/* RFC 9421 HTTP Message Signature verification contract.
 *
 * The first test is the RFC's own Appendix B.2.6 Ed25519 vector: if it
 * verifies, the signature-base reconstruction (§2.5) matches the spec
 * byte-for-byte. The remaining tests exercise policy, failure modes, and
 * locally generated signatures built independently of server.js. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  verifySignedRequest,
  parseSignatureInput,
  parseSignatureHeader,
  signatureBase,
  addVerificationKey,
} = require("../server.js");

/* ── keys ─────────────────────────────────────────────────── */
// RFC 9421 Appendix B.1.4 public key (test-only, per the RFC).
const RFC_PUB = {
  kty: "OKP", crv: "Ed25519", kid: "test-key-ed25519",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};
addVerificationKey(RFC_PUB);

const mine = crypto.generateKeyPairSync("ed25519");
addVerificationKey({
  ...mine.publicKey.export({ format: "jwk" }),
  kid: "kid-alpha", alg: "ed25519",
});

const impostor = crypto.generateKeyPairSync("ed25519");
addVerificationKey({
  ...impostor.publicKey.export({ format: "jwk" }),
  kid: "kid-impostor", alg: "ed25519",
});

/* ── helpers (built independently from server.js) ─────────── */
function manualBase({ method = "GET", url = "/index.html", host = "aegis.example", extra = [] }, input) {
  const qi = url.indexOf("?");
  const pth = qi === -1 ? url : url.slice(0, qi);
  const lines = [
    `"@method": ${method}`,
    `"@path": ${pth}`,
    `"@authority": ${host}`,
    ...extra,
    `"@signature-params": ${input}`,
  ];
  return lines.join("\n");
}

/* Sign a request and return the wire headers for verifySignedRequest(). */
function signedRequest(opts = {}) {
  const method = opts.method || "GET";
  const url = opts.url || "/index.html";
  const host = opts.host || "aegis.example";
  const key = opts.key || mine.privateKey;
  const kid = opts.kid !== undefined ? opts.kid : "kid-alpha";
  const compNames = opts.components || ["@method", "@path", "@authority"];
  const comps = `(${compNames.map((c) => `"${c}"`).join(" ")})`;
  const created = opts.created !== undefined ? opts.created : Math.floor(Date.now() / 1000);
  const params =
    (opts.params !== undefined
      ? opts.params
      : `;created=${created}` + (kid === null ? "" : `;keyid="${kid}"`)) || "";
  const input = comps + params;
  const extraBase = (opts.extraBase || []).map(([name, value]) => `"${name}": ${value}`);
  const base = manualBase({ method, url, host, extra: extraBase }, input);
  const sig = crypto.sign(null, Buffer.from(base, "utf8"), key).toString("base64");
  const headers = {
    host,
    ...(opts.headers || {}),
    "signature-input": `sig1=${input}`,
    signature: opts.rawSignature !== undefined ? opts.rawSignature : `sig1=:${sig}:`,
  };
  return { method, url, headers };
}

/* ── the spec's own vector ────────────────────────────────── */
test("RFC 9421 Appendix B.2.6 Ed25519 test vector verifies as valid", () => {
  const v = verifySignedRequest({
    method: "POST",
    url: "/foo?param=Value&Pet=dog",
    headers: {
      host: "example.com",
      date: "Tue, 20 Apr 2021 02:07:55 GMT",
      "content-type": "application/json",
      "content-length": "18",
      "signature-input":
        'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      signature:
        "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:",
    },
  });
  assert.equal(v.verdict, "valid", v.reason);
  assert.equal(v.keyid, "test-key-ed25519");
  assert.equal(v.alg, "ed25519");
});

/* ── parser ───────────────────────────────────────────────── */
test("parseSignatureInput extracts labels, components, and parameters", () => {
  const entries = parseSignatureInput(
    'sig1=("@method" "@path" "@authority");created=1716168000;keyid="k-1";tag="web-bot-auth"'
  );
  assert.ok(entries && entries.length === 1);
  const e = entries[0];
  assert.equal(e.label, "sig1");
  assert.deepEqual(e.components.map((c) => c.name), ["@method", "@path", "@authority"]);
  assert.equal(e.params.created, "1716168000");
  assert.equal(e.params.keyid, "k-1");
  assert.equal(e.params.tag, "web-bot-auth");
  // input must round-trip exactly — it becomes the @signature-params value
  assert.equal(e.input, '("@method" "@path" "@authority");created=1716168000;keyid="k-1";tag="web-bot-auth"');
});

test("parseSignatureInput handles multiple labels and bare (unquoted) component names", () => {
  const entries = parseSignatureInput(
    'a=(:method :path);created=1, b=("@method" "@path" "user-agent");keyid="x"'
  );
  assert.ok(entries && entries.length === 2);
  assert.equal(entries[0].label, "a");
  assert.deepEqual(entries[0].components.map((c) => c.name), [":method", ":path"]);
  assert.equal(entries[1].label, "b");
  assert.equal(entries[1].params.keyid, "x");
});

test("parseSignatureInput rejects malformed input", () => {
  assert.equal(parseSignatureInput(""), null);
  assert.equal(parseSignatureInput("no-equals-sign"), null);
  assert.equal(parseSignatureInput("sig1=missing-parens"), null);
  assert.equal(parseSignatureInput('sig1=("@method"'), null); // unbalanced
});

test("parseSignatureHeader decodes byte sequences per label", () => {
  const sigs = parseSignatureHeader("sig1=:YWJj:, sig2=:\"ZGVm\":");
  assert.equal(sigs.sig1, "YWJj");
  assert.equal(sigs.sig2, "ZGVm");
});

test("signatureBase reports unsupported derived components instead of guessing", () => {
  const entries = parseSignatureInput('sig1=("@method" "@target-uri");created=1');
  const res = signatureBase({ method: "GET", url: "/", headers: { host: "x" } }, entries[0]);
  assert.ok(res.error);
  assert.match(res.error, /@target-uri/);
});

/* ── happy path with a locally generated key ──────────────── */
test("a locally generated Ed25519 signature verifies", () => {
  const req = signedRequest();
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "valid", v.reason);
  assert.equal(v.keyid, "kid-alpha");
});

test("covered header fields are rebuilt and verified (user-agent component)", () => {
  const req = signedRequest({
    headers: { "user-agent": "AEGIS-Demo/1.0" },
    extraBase: [["user-agent", "AEGIS-Demo/1.0"]],
    components: ["@method", "@path", "@authority", "user-agent"],
  });
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "valid", v.reason);
});

/* ── failure modes ────────────────────────────────────────── */
test("tampering with the path after signing fails verification", () => {
  const req = signedRequest({ url: "/safe" });
  req.url = "/admin"; // attacker swaps the target after signing
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /check failed|not present/);
});

test("a signature made with the wrong private key fails", () => {
  const req = signedRequest({ key: impostor.privateKey, kid: "kid-alpha" }); // claims the honest kid
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /check failed/);
});

test("an unknown keyid is unresolved, never valid", () => {
  const req = signedRequest({ kid: "kid-from-strangers" });
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "unresolved");
  assert.match(v.reason, /not in the local keyring/);
});

test("insufficient component coverage is rejected (Web Bot Auth profile)", () => {
  const req = signedRequest({ components: ["@method", "@path"] }); // no @authority
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /missing @authority/);
});

test("an expired signature is rejected outside the ±120 s window", () => {
  const req = signedRequest({
    params: `;created=${Math.floor(Date.now() / 1000) - 7200};expires=${Math.floor(Date.now() / 1000) - 3600};keyid="kid-alpha"`,
  });
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /expired/);
});

test("a signature created in the future is rejected", () => {
  const req = signedRequest({
    params: `;created=${Math.floor(Date.now() / 1000) + 3600};keyid="kid-alpha"`,
  });
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /future/);
});

test("an unparseable Signature-Input is invalid, not silently skipped", () => {
  const req = signedRequest();
  req.headers["signature-input"] = "garbage without structure";
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /unparseable/);
});

test("signature bytes for a missing label are invalid", () => {
  const req = signedRequest();
  req.headers.signature = "other-label=:YWJj:";
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "invalid");
  assert.match(v.reason, /no signature bytes/);
});

test("an unsupported algorithm is unresolved, not valid", () => {
  const req = signedRequest({ params: ';alg="rot13";keyid="kid-alpha"' });
  const v = verifySignedRequest(req);
  assert.equal(v.verdict, "unresolved");
  assert.match(v.reason, /unsupported algorithm/);
});

test("multiple labels: a valid signature wins over an invalid sibling", () => {
  const a = signedRequest();
  // second label signed correctly with the same key
  const input2 = '("@method" "@path" "@authority");created=' + Math.floor(Date.now() / 1000) + ';keyid="kid-alpha"';
  const base2 = manualBase({}, input2);
  const sig2 = crypto.sign(null, Buffer.from(base2, "utf8"), mine.privateKey).toString("base64");
  a.headers["signature-input"] += `, sig2=${input2}`;
  a.headers.signature += `, sig2=:${sig2}:`;
  const v = verifySignedRequest(a);
  assert.equal(v.verdict, "valid", v.reason);
});

test("legacy :method-style component names verify end-to-end", () => {
  const input = `(":method" ":path" ":authority");created=${Math.floor(Date.now() / 1000)};keyid="kid-alpha"`;
  const base = [
    '":method": GET',
    '":path": /legacy',
    '":authority": aegis.example',
    `"@signature-params": ${input}`,
  ].join("\n");
  const sig = crypto.sign(null, Buffer.from(base, "utf8"), mine.privateKey).toString("base64");
  const v = verifySignedRequest({
    method: "GET",
    url: "/legacy",
    headers: { host: "aegis.example", "signature-input": `sig1=${input}`, signature: `sig1=:${sig}:` },
  });
  assert.equal(v.verdict, "valid", v.reason);
});

test("no signature headers at all reports present:false", () => {
  const v = verifySignedRequest({ method: "GET", url: "/", headers: { host: "x" } });
  assert.equal(v.present, false);
  assert.equal(v.verdict, "none");
});
