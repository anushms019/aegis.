/* ───────────── Web Bot Auth — verification loop ────────── */
const AGENT_OPS = [
  { op: "OpenAI",      agent: "Operator",      kid: "SHA256:9f3ac1e7b2…d40a" },
  { op: "Google",      agent: "Gemini-Search", kid: "SHA256:41cb77d9ee…8b12" },
  { op: "Perplexity",  agent: "Comet",         kid: "SHA256:e20f6aa013…5c9f" },
  { op: "Anthropic",   agent: "Claude-Web",    kid: "SHA256:77d1b0c4aa…1e03" },
  { op: "Microsoft",   agent: "Bing-Agent",    kid: "SHA256:0ab93f77c5…6d21" },
  { op: "ByteDance",   agent: "Doubao-Crawl",  kid: "SHA256:c55e18b902…7fa4" },
];

let jwksFetch = 128403, jwksOk = 127961, jwksBad = 442;

function renderJwks() {
  $("#jwks-n").textContent  = fmtInt(jwksFetch);
  $("#jwks-ok").textContent  = fmtInt(jwksOk);
  $("#jwks-bad").textContent = fmtInt(jwksBad);
}
renderJwks();

function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[rndi(0, 15)];
  return s;
}
function b64url(n) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = "";
  for (let i = 0; i < n; i++) s += A[rndi(0, 63)];
  return s;
}

const hops = $$("#verify-loop .hop");
const verifyState = $("#verify-state");
let verifyBusy = false;

async function runVerification() {
  if (verifyBusy || liveMode) return;
  verifyBusy = true;
  const ag = pick(AGENT_OPS);
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300;
  const forged = Math.random() < 0.16; // unsigned / forged traffic
  const path = pick(["/api/v1/catalog/search", "/pricing", "/docs/quickstart", "/products/88213", "/.well-known/robot.txt"]);

  verifyState.textContent = "VERIFYING…";
  verifyState.className = "badge info";
  hops.forEach((h) => h.classList.remove("active"));
  $("#hdr-agent").textContent = forged ? "no Signature-Agent header" : `${ag.op} · ${ag.agent}`;

  const sig = b64url(64);
  $("#hdr-block").innerHTML = forged
    ? `<span class="k">GET</span> ${path}
<span class="k">user-agent:</span> <span class="badv">Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0</span>
<span class="k">signature-input:</span> <span class="badv">(absent)</span>
<span class="k">signature-agent:</span> <span class="badv">(absent)</span>
<span class="k">x-forwarded-for:</span> <span class="warnv">rotating · 14 hops · datacenter ASN</span>
<span class="k">verdict:</span> <span class="badv">→ behavioral scoring path</span>`
    : `<span class="k">GET</span> ${path}
<span class="k">signature-input:</span> <span class="v">(:method/:authority/:path);created=${created};expires=${expires};tag="web-bot-auth"</span>
<span class="k">signature:</span> <span class="v">:${sig.slice(0, 48)}…</span>
<span class="k">signature-agent:</span> <span class="v">https://${ag.op.toLowerCase().replace(/[^a-z]/g, "")}.ai/.well-known/http-message-signatures-directory#:keyid=${ag.kid}</span>
<span class="k">content-digest:</span> <span class="v">sha-256=:${b64url(43)}:</span>`;

  for (let i = 0; i < hops.length; i++) {
    if (liveMode) { verifyBusy = false; return; } // a real source attached mid-sim — hand over
    hops.forEach((h) => h.classList.remove("active"));
    for (let j = 0; j <= i; j++) hops[j].classList.add("active");
    $("#verify-log").textContent =
      `[${nowStamp()}] hop ${i + 1}/6 · ${[
        "parsing Signature-Input / Signature / Signature-Agent",
        "resolving Signature-Agent URI",
        `fetching JWKS (kid=${ag.kid})`,
        "validating Content-Digest + freshness window",
        "Ed25519 signature verification over signature base",
        "consulting agent identity registry → trust decision",
      ][i]}`;
    await new Promise((r) => setTimeout(r, rndi(140, 320)));
  }

  jwksFetch++;
  if (forged) {
    jwksBad++;
    verifyState.textContent = "REJECTED";
    verifyState.className = "badge bad";
    $("#verify-log").textContent =
      `[${nowStamp()}] ✗ no valid signature → escalated to behavioral biometrics pipeline (shadow-agent track)`;
  } else {
    jwksOk++;
    verifyState.textContent = "VERIFIED";
    verifyState.className = "badge ok";
    $("#verify-log").textContent =
      `[${nowStamp()}] ✓ ${ag.op}/${ag.agent} authenticated · keyid=${ag.kid} · privacy-preserving (no human identifier)`;
  }
  renderJwks();
  await new Promise((r) => setTimeout(r, 900));
  hops.forEach((h) => h.classList.remove("active"));
  verifyState.textContent = "IDLE";
  verifyState.className = "badge ok";
  verifyBusy = false;
}
setInterval(() => { if (!liveMode) runVerification(); }, 4200);
runVerification();

