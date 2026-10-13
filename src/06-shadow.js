/* ─────────────── Shadow-agent detection feed ───────────── */
const ENGINES = ["Chromium 131 (patched)", "Firefox Gecko (recompiled)", "WebKit fork", "Playwright vanilla", "Puppeteer-stealth"];
/* SIM rows reuse the signal vocabulary the server actually emits
   (AUTOMATION_RULES / browser-claim heuristic / missing-UA in server.js).
   Simulated rows must never name a detector this project does not build:
   no TLS-fingerprint analysis, no debugger-timing analysis, no pointer
   dynamics — those live only in the framed research matrix in section 03. */
const SIGNALS = [
  ["Headless Chrome (patched-engine track)", 96],
  ["automation framework", 92],
  ["headless client", 90],
  ["PhantomJS", 94],
  ["Mozilla UA without sec-ch-ua / accept-language / sec-fetch-*", 82],
  ["missing User-Agent header", 71],
];
function fpHash() {
  return [8, 4, 4, 4, 12].map((n) => hex(n)).join("-");
}
/* small DOM helpers: build cells/rows without ever parsing a string as HTML */
function cell(text, cls, style) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (style) td.setAttribute("style", style);
  td.textContent = text == null ? "" : String(text);
  return td;
}
function badgeCell(text, cls) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = "badge " + (cls || "");
  span.textContent = String(text);
  td.appendChild(span);
  return td;
}
function row(cells) { const tr = document.createElement("tr"); cells.forEach((c) => tr.appendChild(c)); return tr; }

function addShadowRow() {
  const [signal, conf] = pick(SIGNALS);
  const tr = row([
    cell(nowStamp().slice(0, 8), "mono dim"),
    cell(fpHash(), "mono"),
    cell(pick(ENGINES), "dim", "font-size:11.5px"),
    cell(signal),
    badgeCell(conf + "%", conf > 93 ? "bad" : "warn"),
  ]);
  const body = $("#shadow-body");
  body.prepend(tr);
  while (body.children.length > 40) body.lastChild.remove();
}
for (let i = 0; i < 9; i++) addShadowRow();
setInterval(() => { if (!liveMode) addShadowRow(); }, 2600);

