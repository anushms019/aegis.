/* ─────────────── Shadow-agent detection feed ───────────── */
const ENGINES = ["Chromium 131 (patched)", "Firefox Gecko (recompiled)", "WebKit fork", "Playwright vanilla", "Puppeteer-stealth"];
const SIGNALS = [
  ["isTrusted dispatch cadence", 97],
  ["JA4+ TLS fingerprint drift", 91],
  ["Canvas hash persistence across 9 regions", 99],
  ["Bézier jitter regularity", 88],
  ["CDP attach timing residual", 94],
  ["Fitts-law dwell mismatch", 86],
  ["Font metric degeneration gap", 90],
  ["navigator.webdriver equivocation", 78],
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

