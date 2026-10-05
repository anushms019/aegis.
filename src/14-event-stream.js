/* ═══════════════ Live event stream + rate + burst ═══════════════
   Unified pipeline: real SSE events (ingestReal) and the simulator both
   funnel through pushEvent(), which feeds the event table, the 10-second
   rate buckets, and the shadow-burst detector. Panels carry the same
   LIVE / SIM feed tag as the rest of the console. */

const KIND_COLORS = { signed: "#4d9dff", known: "#37e6d4", shadow: "#ff5470", tool: "#ffc94d", human: "#8b93b5" };
const EV_CAP = 200;               // ring buffer for export
const EV_ROWS_VISIBLE = 60;       // DOM rows
const BUCKET_MS = 10000;          // 10 s rate buckets
const BUCKETS = 60;               // × 60 = 10 minutes
const BURST_WINDOW_MS = 60000;
const BURST_THRESHOLD = 8;
/* Stream state lives in one object so interval timers, the SSE feed and
   the filter UI all mutate a single well-known owner instead of six
   loose globals — nothing can reassign half the module by accident. */
const Stream = {
  eventLog: [],
  evTotal: 0,
  evPaused: false,
  evFilter: "all",
  shadowTimes: [],
  rateBuckets: [],
};

function bucketAt(t) {
  const bt = Math.floor(t / BUCKET_MS) * BUCKET_MS;
  const empty = (x) => ({ t: x, signed: 0, known: 0, shadow: 0, tool: 0, human: 0 });
  const rb = Stream.rateBuckets;
  if (!rb.length) {
    for (let x = bt - (BUCKETS - 1) * BUCKET_MS; x <= bt; x += BUCKET_MS) rb.push(empty(x));
    return rb[rb.length - 1];
  }
  const last = rb[rb.length - 1];
  if (bt > last.t) {
    for (let x = last.t + BUCKET_MS; x <= bt; x += BUCKET_MS) rb.push(empty(x));
    while (rb.length > BUCKETS) rb.shift();
    return rb[rb.length - 1];
  }
  if (bt < rb[0].t) return null; // outside the 10-minute window
  return rb.find((b) => b.t === bt) || last;
}

/* Telemetry rows are built with DOM nodes + textContent, never
   interpolated HTML: paths, User-Agents, header values and agent names
   are attacker-controlled, so they must never reach a parser as markup. */
function td(text, cls) {
  const cell = document.createElement("td");
  if (cls) cell.className = cls;
  cell.textContent = text == null ? "" : String(text);
  return cell;
}

function sigCell(sig) {
  const cell = document.createElement("td");
  const span = document.createElement("span");
  if (sig === "valid") { span.className = "ev-sig-ok"; span.textContent = "✓ valid"; }
  else if (sig === "invalid") { span.className = "ev-sig-bad"; span.textContent = "✗ invalid"; }
  else if (sig === "unresolved") { span.className = "ev-sig-pend"; span.textContent = "? no key"; }
  else if (sig) { span.className = "ev-sig-pend"; span.textContent = String(sig); }
  else { span.className = "dim"; span.textContent = "—"; }
  cell.appendChild(span);
  return cell;
}

function evRowEl(ev) {
  const tr = document.createElement("tr");
  tr.appendChild(td(new Date(ev.t).toISOString().slice(11, 19), "dim"));
  const kindCell = document.createElement("td");
  const dot = document.createElement("span");
  dot.className = "ev-dot";
  dot.style.background = KIND_COLORS[ev.kind] || "#8b93b5";
  kindCell.appendChild(dot);
  kindCell.appendChild(document.createTextNode(String(ev.kind)));
  tr.appendChild(kindCell);
  tr.appendChild(td(ev.method, "mono"));
  const pathCell = td(ev.path, "path"); // title set as a property, not markup
  pathCell.title = ev.path == null ? "" : String(ev.path);
  tr.appendChild(pathCell);
  tr.appendChild(td(ev.agent, "mono ev-agent"));
  tr.appendChild(td(ev.status));
  tr.appendChild(td(ev.ms, "dim"));
  tr.appendChild(sigCell(ev.sig));
  return tr;
}

function renderEventRow(ev) {
  const body = $("#ev-body");
  if (!body) return;
  body.prepend(evRowEl(ev));
  while (body.children.length > EV_ROWS_VISIBLE) body.lastChild.remove();
}

function renderEventList() {
  const body = $("#ev-body");
  if (!body) return;
  body.replaceChildren();
  for (const ev of Stream.eventLog) {
    if (Stream.evFilter !== "all" && ev.kind !== Stream.evFilter) continue;
    body.appendChild(evRowEl(ev));
    if (body.children.length >= EV_ROWS_VISIBLE) break;
  }
}

function updateEvCount() {
  const el = $("#ev-count");
  if (el) el.textContent = `${fmtInt(Stream.evTotal)} captured`;
}

function pushEvent(ev) {
  Stream.eventLog.unshift(ev);
  if (Stream.eventLog.length > EV_CAP) Stream.eventLog.pop();
  Stream.evTotal++;
  const b = bucketAt(ev.t);
  if (b && Object.prototype.hasOwnProperty.call(b, ev.kind)) b[ev.kind]++;
  if (ev.kind === "shadow") { Stream.shadowTimes.push(ev.t); checkBurst(); }
  if (!Stream.evPaused && (Stream.evFilter === "all" || Stream.evFilter === ev.kind)) renderEventRow(ev);
  updateEvCount();
}

/* rate chart: stacked 10 s buckets, newest at the right */
function drawRate() {
  const cv = $("#chart-rate");
  if (!cv || !cv.clientWidth) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h);
  const order = ["human", "tool", "known", "shadow", "signed"];
  const totals = Stream.rateBuckets.map((b) => order.reduce((s, k) => s + b[k], 0));
  const max = Math.max(4, ...totals);
  const bw = w / BUCKETS;
  const pad = 14;
  Stream.rateBuckets.forEach((b, i) => {
    let y = h - pad;
    for (const k of order) {
      const v = (b[k] / max) * (h - pad - 8);
      if (v > 0) {
        ctx.fillStyle = KIND_COLORS[k];
        ctx.globalAlpha = 0.85;
        ctx.fillRect(i * bw, y - v, Math.max(bw - 1.5, 1), v);
        ctx.globalAlpha = 1;
        y -= v;
      }
    }
  });
  ctx.font = "10px monospace";
  ctx.fillStyle = "#4b5470";
  ctx.fillText("10 min ago", 4, h - 3);
  const nowLbl = liveMode ? "now · LIVE" : "now · SIM";
  const tw = ctx.measureText(nowLbl).width;
  ctx.fillStyle = liveMode ? "#3dff9e" : "#ffc94d";
  ctx.fillText(nowLbl, w - tw - 4, h - 3);
  ctx.fillStyle = "#7c87a8";
  const peak = max + " req peak";
  ctx.fillText(peak, w - ctx.measureText(peak).width - 4, 11);
}

/* shadow-burst detector — fires at 8/60 s, clears below 4 (hysteresis) */
function checkBurst() {
  const el = $("#alert-banner");
  if (!el) return;
  const now = Date.now();
  Stream.shadowTimes = Stream.shadowTimes.filter((t) => now - t < BURST_WINDOW_MS);
  if (Stream.shadowTimes.length >= BURST_THRESHOLD) {
    el.hidden = false;
    const txt = $("#alert-text");
    if (txt) txt.textContent = `Shadow burst — ${Stream.shadowTimes.length} stealth requests in the last 60 s`;
  } else if (Stream.shadowTimes.length < 4) {
    el.hidden = true;
  }
}
setInterval(checkBurst, 3000);

/* controls: kind filter, pause, JSON export */
$$("#ev-filters .chip[data-filter]").forEach((c) => {
  c.addEventListener("click", () => {
    Stream.evFilter = c.dataset.filter;
    $$("#ev-filters .chip[data-filter]").forEach((x) => {
      const on = x === c;
      x.classList.toggle("active", on);
      x.setAttribute("aria-pressed", on ? "true" : "false");
    });
    renderEventList();
  });
});
const pauseBtn = $("#ev-pause");
if (pauseBtn) pauseBtn.addEventListener("click", () => {
  Stream.evPaused = !Stream.evPaused;
  pauseBtn.textContent = Stream.evPaused ? "▶ Resume" : "⏸ Pause";
  pauseBtn.classList.toggle("paused", Stream.evPaused);
  pauseBtn.setAttribute("aria-pressed", Stream.evPaused ? "true" : "false");
});
const exportBtn = $("#ev-export");
if (exportBtn) exportBtn.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(Stream.eventLog, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "aegis-events-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "") + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

/* simulator feed — the table and rate chart stay populated in SIM mode */
const SIM_EVENT_AGENTS = {
  signed: ["Operator (OpenAI)", "Gemini-Search (Google)", "Claude-Web (Anthropic)", "Comet (Perplexity)"],
  known: ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot", "Bytespider", "bingbot"],
  shadow: ["Headless Chrome (patched-engine)", "browser claim, no client hints", "no user-agent", "automation framework"],
  tool: ["scripted client (curl)", "scripted client (python-requests)"],
  human: ["browser (Chrome)", "browser (Safari)", "browser (Firefox)"],
};
const SIM_EVENT_PATHS = ["/", "/index.html", "/pricing", "/docs/quickstart", "/api/v1/catalog/search", "/products/88213", "/.well-known/robot.txt", "/blog/agent-economy", "/robots.txt"];
function simEvent() {
  const r = Math.random();
  const kind = r < 0.25 ? "known" : r < 0.55 ? "human" : r < 0.7 ? "shadow" : r < 0.85 ? "tool" : "signed";
  const sig = kind === "signed" ? (Math.random() < 0.7 ? "valid" : Math.random() < 0.6 ? "invalid" : "unresolved") : null;
  pushEvent({
    t: Date.now(),
    kind,
    method: Math.random() < 0.08 ? "POST" : "GET",
    path: pick(SIM_EVENT_PATHS),
    agent: pick(SIM_EVENT_AGENTS[kind]),
    status: kind === "shadow" && Math.random() < 0.25 ? 403 : 200,
    ms: rndi(7, 180),
    sig,
    source: "sim",
  });
}
setInterval(() => { if (!liveMode) simEvent(); }, 1600);
setInterval(drawRate, 2000);
for (let i = 0; i < 14; i++) simEvent(); // seed the stream on first paint
requestAnimationFrame(drawRate);

