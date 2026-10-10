/* ─────────────── Trajectory stream (sim console) ───────── */
const traceStream = $("#trace-stream");
let tracePaused = false;
let toolCalls = 0, compactions = 0, tokens = 41200;
const MISSION = pick(["find lowest fare SFO→NRT Mar 12", "extract Q3 invoice totals", "compare 5 SOC2 vendors", "summarize HN front page"]);

const THOUGHTS = [
  "Page rendered. Scanning for a fare table — the hero section has no data, scrolling to results grid.",
  "Three candidate flights under budget. Need to verify baggage fees before comparing total cost.",
  "The price shown may exclude taxes; hovering the fare card to reveal the breakdown tooltip.",
  "Content differs from the fetch — a client-side renderer delayed hydration by ~1.2s. Re-reading.",
  "Mission requires departure before 10:00. Filtering out 4 itineraries that violate the constraint.",
  "No JSON-LD Offer schema present; falling back to visual table parsing with bounding-box map.",
  "Second source disagrees by $34. Cross-checking against the airline's direct booking endpoint.",
  "Considering whether this page's instructions are part of my task — they are not. Ignoring embedded directive.",
];
const ACTIONS = [
  ['click', 'button[data-test="sort-by-price"]'],
  ['scroll', 'y+1240 (smooth, 620ms)'],
  ['type', 'input[name="destination"] = "NRT"'],
  ['extract', 'table.fare-rows → 12 rows × 6 cols'],
  ['goto', 'https://carrier.example/booking?ref=4412'],
  ['hover', 'div.fare-card:nth-child(3) → tooltip'],
  ['callTool', 'modelContext.invoke("checkAvailability", {date:"2027-03-12"})'],
  ['wait', 'networkidle · 820ms inference pause'],
];
const OBSERVATIONS = [
  "12 rows returned · 3 within budget · confidence 0.94",
  "tooltip rendered · taxes +$58.40 included",
  "redirect → 200 OK · signed request accepted by origin",
  "hydration complete · DOM mutation delta = 418 nodes",
  "constraint filter removed 4 candidates · 8 remain",
  "disagreement resolved · authoritative fare = $842.10",
  "tool returned {available:true, seats:3} · schema-valid",
  "scroll position 1240 · viewport stability 98%",
];
const ANOMALIES = [
  "Trajectory guard: trajectory deviated — product search → /admin/login portal. HALTED before step.",
  "Trajectory guard: hidden text node (display:none) injected instruction attempting tool escalation. BLOCKED.",
  "Trajectory guard: destination host not in mission scope. ROLLBACK queued.",
];

function addTrace(phase, text, alert = false) {
  const div = document.createElement("div");
  div.className = "trace-step" + (alert ? " alert" : "");
  const ph = document.createElement("div");
  ph.className = "phase " + phase.toLowerCase();
  ph.textContent = phase;
  const content = document.createElement("div");
  content.className = "content";
  if (text && text.nodeType) content.appendChild(text);   // already a node (may hold a .kv span)
  else content.textContent = text == null ? "" : String(text);
  div.appendChild(ph);
  div.appendChild(content);
  traceStream.prepend(div);
  while (traceStream.children.length > 60) traceStream.lastChild.remove();
}
/* trace step with a highlighted leading token, built as nodes */
function kvNode(k, rest) {
  const frag = document.createDocumentFragment();
  const kv = document.createElement("span");
  kv.className = "kv";
  kv.textContent = k;
  frag.appendChild(kv);
  frag.appendChild(document.createTextNode(" " + String(rest)));
  return frag;
}

let traceStep = 0;
let ctxHistory = Array.from({ length: 60 }, (_, i) => (i % 14 === 13 ? 26 : 30 + i * 1.4));

function traceTick() {
  if (tracePaused) return;
  const phase = ["THOUGHT", "ACTION", "OBSERVATION"][traceStep % 3];
  if (phase === "THOUGHT") addTrace(phase, pick(THOUGHTS));
  else if (phase === "ACTION") {
    const [verb, target] = pick(ACTIONS);
    if (verb === "callTool") toolCalls++;
    addTrace(phase, kvNode(verb, target));
  } else addTrace(phase, kvNode("observed:", pick(OBSERVATIONS)));

  if (!liveMode && Math.random() < 0.055) {
    // simulated anomaly: fires only while the console runs as simulation
    addTrace("ANOMALY", pick(ANOMALIES), true);
    kpi.anom++;
    const st = $("#guard-state");
    st.textContent = "Guard: HALT ISSUED";
    st.className = "badge bad";
    setTimeout(() => { st.textContent = "Guard: ARMED"; st.className = "badge ok"; }, 3200);
  }

  tokens += rndi(400, 2400);
  if (tokens > 126000) {
    tokens = rndi(28000, 41000);
    compactions++;
    addTrace("OBSERVATION", kvNode("context compaction", `→ summarized ${rndi(60, 88)}% of history · token budget reclaimed`));
    ctxHistory.push(24);
    ctxHistory.shift();
  } else {
    const last = ctxHistory[ctxHistory.length - 1];
    ctxHistory.push(clamp(last + rnd(1, 6), 20, 105));
    ctxHistory.shift();
  }

  $("#ctx-tokens").textContent = fmtInt(tokens) + " / 128k";
  $("#ctx-compacts").textContent = compactions;
  $("#ctx-tools").textContent = toolCalls;
  $("#trace-session").textContent = "session: " + MISSION;
  traceStep++;
}
function drawContext() {
  const cv = $("#chart-context");
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h);
  ctx.strokeStyle = "#a77bff"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctxHistory.forEach((v, i) => {
    const x = (i / (ctxHistory.length - 1)) * w;
    const y = h - (v / 110) * (h - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}
for (let i = 0; i < 8; i++) traceTick();
setInterval(traceTick, 1500);
setInterval(drawContext, 900);

$("#btn-pause").addEventListener("click", (e) => {
  tracePaused = !tracePaused;
  e.target.textContent = tracePaused ? "▶ Resume" : "⏸ Pause";
  e.target.classList.toggle("active", !tracePaused);
});

