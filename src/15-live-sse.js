/* ═══════════════ Real capture feed (SSE) ═══════════════
   Connects to the capture server's /events stream. When attached:
     - entry / detection / header panels show REAL classified requests
     - KPIs 1–3 switch to real counters
     - every other panel stays simulated and is tagged [SIM]
   Opened via file:// (no server) → everything stays simulated. */

const SIM_TAGGED = [
  ".map-wrap", "#region-bars", "#registry-body",
  "#chart-istrusted", "#chart-entropy", "#chart-pause",
  "#trace-stream", "#chart-context",
  "#citation-bars", "#chart-cep",
  "#mcp-body", "#chart-revenue", "#pub-body",
  "#ipi-bars", "#ipi-body", "#gate-blocked",
  "#ev-body", "#chart-rate",
];
const LIVE_TAGGED = ["#verify-log", "#hdr-block", "#shadow-body", "#ev-body", "#chart-rate"];

function feedTag(el, label) {
  if (!el || !el.closest) return;
  const panel = el.closest(".panel");
  const head = panel && panel.querySelector(".panel-head");
  if (!head) return;
  let tag = head.querySelector(".feed-tag");
  if (!tag) {
    tag = document.createElement("span");
    tag.className = "tag feed-tag";
    head.insertBefore(tag, head.querySelector(".right"));
  }
  tag.textContent = label;
  const color = label === "LIVE" ? "#3dff9e" : "#ffc94d";
  tag.style.color = color;
  tag.style.borderColor = color + "66";
}

function setPill(text, mode) {
  const pill = $("#feed-pill");
  const txt = $("#feed-pill-text");
  if (!pill || !txt) return;
  txt.textContent = text;
  const color = mode === "live" ? "#3dff9e" : mode === "warn" ? "#ff5470" : "#ffc94d";
  pill.style.color = color;
  pill.style.borderColor = color + "59";
  pill.style.background = mode === "live" ? "rgba(61,255,158,.07)" : mode === "warn" ? "rgba(255,84,112,.07)" : "rgba(255,201,77,.07)";
  const dot = pill.querySelector(".dot");
  if (dot) dot.style.background = color;
}

function applySourceState() {
  SIM_TAGGED.forEach((s) => { const el = $(s); if (el) feedTag(el, "SIM"); });
  LIVE_TAGGED.forEach((s) => { const el = $(s); if (el) feedTag(el, liveMode ? "LIVE" : "SIM"); });
  if (!liveMode) {
    setPill("Simulated Feed", "sim");
    // KPI cards have no panel-head tag — mark their labels as simulated
    // so a file:// demo can never be mistaken for captured traffic.
    ["#kpi-agents", "#kpi-signed", "#kpi-shadow", "#kpi-anom", "#kpi-ipi", "#kpi-rev"].forEach((sel) => {
      const el = $(sel);
      const l = el && el.closest(".kpi") && el.closest(".kpi").querySelector(".label");
      if (l && !l.textContent.includes("· SIM")) l.textContent += " · SIM";
    });
  }
  const at = $("#alert-tag");
  if (at) at.textContent = liveMode ? "LIVE" : "SIM";
}

function markLabelsLive() {
  if (labelsMarked) return;
  labelsMarked = true;
  const lab = (sel) => { const el = $(sel); return el ? el.closest(".kpi").querySelector(".label") : null; };
  const setLab = (sel, txt) => { const l = lab(sel); if (l) l.textContent = txt; };
  setLab("#kpi-agents", "Requests Captured · since server start");
  setLab("#kpi-signed", "Signed Entries · RFC 9421 · live");
  setLab("#kpi-shadow", "Shadow Agents Detected · live");
  // signal cards become real server counters — rename honestly and
  // drop the fabricated trend deltas
  setLab("#kpi-anom", "Trajectory-flagged events · live");
  setLab("#kpi-ipi", "IPI-flagged requests · live");
  setLab("#kpi-rev", "Crawler revenue signals · live");
  const d = (id) => { const el = $(id); if (el) el.textContent = ""; };
  d("#kpi-agents-d");
  d("#kpi-anom-d");
  d("#kpi-ipi-d");
  d("#kpi-rev-d");
  if ($("#kpi-signed-d")) { $("#kpi-signed-d").textContent = "signed ÷ captured requests"; $("#kpi-signed-d").className = "delta flat"; }
  if ($("#kpi-shadow-d")) { $("#kpi-shadow-d").textContent = "real classification"; $("#kpi-shadow-d").className = "delta flat"; }
  // verification-panel counters become real in live mode — rename honestly
  const jwksLabel = (sel, txt) => {
    const el = $(sel);
    const l = el && el.parentElement && el.parentElement.querySelector(".l");
    if (l) l.textContent = txt;
  };
  jwksLabel("#jwks-n", "Signed attempts · live");
  jwksLabel("#jwks-ok", "Verified ✓ · live");
  jwksLabel("#jwks-bad", "Rejected ✗ · live");
}

function enterLiveMode() {
  applySourceState();
  markLabelsLive();
  const sb = $("#shadow-body");
  if (sb) sb.innerHTML = "";
  // seize the shared ledgers: drop simulated rows so live rows can never
  // sit next to mocks (their sim generators pause while liveMode is set)
  const mb = $("#mcp-body");
  if (mb) mb.innerHTML = "";
  const ib = $("#ipi-body");
  if (ib) ib.innerHTML = "";
  if (typeof mcpOk !== "undefined") { mcpOk = 0; mcpAll = 0; }
  const md = $("#mcp-discovered"); if (md) md.textContent = "0 discovered";
  const ms = $("#mcp-success"); if (ms) ms.textContent = "— success";
  // hand the event stream over to real data
  Stream.eventLog = [];
  Stream.evTotal = 0;
  Stream.shadowTimes = [];
  Stream.rateBuckets.length = 0;
  Stream.evPaused = false;
  Stream.evFilter = "all";
  const eb = $("#ev-body");
  if (eb) eb.innerHTML = "";
  $$("#ev-filters .chip").forEach((c) => c.classList.toggle("active", c.dataset.filter === "all"));
  const pb = $("#ev-pause");
  if (pb) { pb.textContent = "⏸ Pause"; pb.classList.remove("paused"); }
  updateEvCount();
  checkBurst();
  const log = $("#verify-log");
  if (log) log.textContent = `[${nowStamp()}] live capture attached · awaiting classified request…`;
  // clear the simulator's placeholder header block — nothing here is real yet
  const hb = $("#hdr-block");
  if (hb) hb.innerHTML = '<span class="dim">awaiting classified request…</span>';
  const ha = $("#hdr-agent");
  if (ha) ha.textContent = "—";
  const hv = $("#hdr-verdict");
  if (hv) { hv.textContent = "—"; hv.className = "badge info"; }
  hops.forEach((h) => h.classList.remove("active"));
  verifyState.textContent = "WAITING";
  verifyState.className = "badge info";
}

function renderRealHeaders(ev) {
  const agentEl = $("#hdr-agent");
  if (agentEl) agentEl.textContent = `${ev.agent.name} · ${ev.kind.toUpperCase()}`;
  const h = ev.headers || {};
  const lines = [];
  lines.push(`<span class="k">${escHtml(ev.method)}</span> ${escHtml(ev.path)}`);
  lines.push(`<span class="k">from:</span> <span class="v">${escHtml(ev.ip)}</span> <span class="dim">(${ev.source === "log" ? "access-log tail" : "live socket"})</span>`);
  lines.push(`<span class="k">user-agent:</span> ${ev.kind === "shadow" || ev.kind === "tool" ? '<span class="warnv">' + escHtml(ev.ua || "(none)") + "</span>" : '<span class="v">' + escHtml(ev.ua || "(none)") + "</span>"}`);
  lines.push(`<span class="k">accept-language:</span> ${ev.lang ? escHtml(ev.lang) : '<span class="warnv">(absent)</span>'}`);
  lines.push(`<span class="k">signature-input:</span> ${h["signature-input"] ? '<span class="v">' + escHtml(h["signature-input"]) + "</span>" : '<span class="badv">(absent)</span>'}`);
  lines.push(`<span class="k">signature:</span> ${h["signature"] ? '<span class="v">:' + escHtml(h["signature"]) + "…</span>" : '<span class="badv">(absent)</span>'}`);
  lines.push(`<span class="k">signature-agent:</span> ${h["signature-agent"] ? '<span class="v">' + escHtml(h["signature-agent"]) + "</span>" : '<span class="badv">(absent)</span>'}`);
  const vb = $("#hdr-verdict");
  if (ev.signed && ev.signed.present && ev.signed.verdict && ev.signed.verdict !== "none") {
    const v = ev.signed.verdict;
    const vcls = v === "valid" ? "v" : v === "invalid" ? "badv" : "warnv";
    lines.push(`<span class="k">verdict:</span> <span class="${vcls}">${v.toUpperCase()} — ${escHtml(ev.signed.reason || "")}${ev.signed.keyid ? " · kid=" + escHtml(ev.signed.keyid) : ""}${ev.signed.alg ? " · " + escHtml(ev.signed.alg) : ""}</span>`);
    if (vb) {
      vb.textContent = v === "valid" ? "SIG VALID ✓" : v === "invalid" ? "SIG INVALID ✗" : "KEY PENDING ?";
      vb.className = "badge " + (v === "valid" ? "ok" : v === "invalid" ? "bad" : "warn");
    }
  } else if (vb) {
    vb.textContent = "UNSIGNED";
    vb.className = "badge info";
  }
  if (ev.shadow) lines.push(`<span class="k">detection:</span> <span class="badv">${escHtml(ev.shadow.signal)} · ${ev.shadow.conf}%</span>`);
  lines.push(`<span class="k">classification:</span> <span class="v">${ev.kind.toUpperCase()} → ${escHtml(ev.agent.name)}${ev.agent.op ? " (" + escHtml(ev.agent.op) + ")" : ""}</span>`);
  $("#hdr-block").innerHTML = lines.join("\n");
}

async function driveVerify(ev) {
  if (verifyBusy) { pendingVerify = ev; return; }
  verifyBusy = true;
  try {
    hops.forEach((h) => h.classList.remove("active"));
    if (ev.signed && ev.signed.present) {
      verifyState.textContent = "VERIFYING…";
      verifyState.className = "badge info";
      const si = ev.signed.input || "";
      const verdict = ev.signed.verdict && ev.signed.verdict !== "none" ? ev.signed.verdict : null;
      const alg = ev.signed.alg || "algorithm unresolved";
      const kid = ev.signed.keyid || "(no keyid)";
      const reason = ev.signed.reason || "";
      const hasTag = /tag="web-bot-auth"/.test(si);
      const mC = /created=(\d+)/.exec(si);
      const mE = /expires=(\d+)/.exec(si);
      const nowS = Math.floor(Date.now() / 1000);
      const windowOk = !!(mC && mE && nowS >= Number(mC[1]) - 120 && nowS <= Number(mE[1]) + 120);
      const steps = verdict
        ? [
            `parsing Signature-Input (${si.length} bytes), ${(si.match(/"/g) || []).length / 2 | 0} covered components`,
            `resolving Signature-Agent → ${ev.signed.agent || "(header absent)"}`,
            `local keyring lookup → kid=${kid}${verdict === "unresolved" ? " — NOT FOUND" : " ✓"}`,
            `coverage + freshness → ${/coverage|expired|future|missing/i.test(reason) ? "POLICY FAIL" : "within policy ✓"}`,
            `${alg} verify … ${verdict === "valid" ? "OK ✓" : verdict === "invalid" ? "FAILED ✗" : "SKIPPED — key material unavailable"}`,
            `trust decision → ${verdict.toUpperCase()}`,
          ]
        : [
            `parsing Signature-Input (${si.length} bytes), components: ${/[:@][a-z]/i.test(si) ? "method/authority/path" : "custom"}`,
            `resolving Signature-Agent → ${ev.signed.agent || "(header absent)"}`,
            "local keyring lookup … no verdict attached to this event",
            `Content-Digest: ${ev.headers && ev.headers["content-digest"] ? "present ✓" : "absent — not covered"}`,
            "cryptographic verify … UNAVAILABLE (event predates the verifier)",
            `local checks → tag=${hasTag ? "web-bot-auth ✓" : "MISSING"} · created/expires ${windowOk ? "within ±120s ✓" : "STALE/ABSENT"}`,
          ];
      for (let i = 0; i < hops.length; i++) {
        hops.forEach((h, j) => h.classList.toggle("active", j <= i));
        $("#verify-log").textContent = `[${nowStamp()}] hop ${i + 1}/6 · ${steps[i]}`;
        await new Promise((r) => setTimeout(r, 170));
      }
      if (verdict === "valid") {
        verifyState.textContent = "SIGNATURE VALID ✓";
        verifyState.className = "badge ok";
        $("#verify-log").textContent = `[${nowStamp()}] ✓ ${reason} · kid=${kid}${ev.signed.label ? " · label=" + escHtml(ev.signed.label) : ""}`;
      } else if (verdict === "invalid") {
        verifyState.textContent = "SIGNATURE INVALID ✗";
        verifyState.className = "badge bad";
        $("#verify-log").textContent = `[${nowStamp()}] ✗ ${escHtml(reason)} → classified: INVALID`;
      } else if (verdict === "unresolved") {
        verifyState.textContent = "KEY NOT FOUND ?";
        verifyState.className = "badge warn";
        $("#verify-log").textContent = `[${nowStamp()}] ? ${escHtml(reason)} → held as unverified (never counted as trusted)`;
      } else {
        const ok = hasTag && windowOk;
        verifyState.textContent = ok ? "HEADERS OK · KEYS PENDING" : "HEADER CHECK FAILED";
        verifyState.className = "badge " + (ok ? "info" : "bad");
        $("#verify-log").textContent = `[${nowStamp()}] ${ok ? "✓ structure + freshness validated locally; no cryptographic verdict on this event" : "✗ tag/freshness check failed → rejected"}`;
      }
    } else if (ev.kind === "shadow") {
      verifyState.textContent = "SHADOW · UNSIGNED";
      verifyState.className = "badge bad";
      hops[0].classList.add("active");
      $("#verify-log").textContent = `[${nowStamp()}] ✗ unsigned + "${escHtml(ev.shadow ? ev.shadow.signal : "automation signal")}" (${ev.shadow ? ev.shadow.conf : 0}% conf) → classified as shadow: unsigned + headless UA`;
    } else if (ev.kind === "known") {
      verifyState.textContent = `KNOWN · ${ev.agent.name}`;
      verifyState.className = "badge warn";
      hops[0].classList.add("active");
      $("#verify-log").textContent = `[${nowStamp()}] ${escHtml(ev.agent.op)}/${escHtml(ev.agent.name)} matched by published agent User-Agent — classified as known (unsigned; no signature to verify)`;
    } else if (ev.kind === "tool") {
      verifyState.textContent = "NON-BROWSER CLIENT";
      verifyState.className = "badge info";
      hops[0].classList.add("active");
      $("#verify-log").textContent = `[${nowStamp()}] scripted client observed · ${escHtml(ev.ua).slice(0, 70)} → classified as tool`;
    } else {
      verifyState.textContent = "BROWSER TRAFFIC";
      verifyState.className = "badge ok";
      hops[0].classList.add("active");
      $("#verify-log").textContent = `[${nowStamp()}] browser-shaped request, unsigned → classified as human · ${escHtml(ev.path)}`;
    }
    await new Promise((r) => setTimeout(r, 700));
    hops.forEach((h) => h.classList.remove("active"));
    if (!(ev.signed && ev.signed.present)) {
      verifyState.textContent = "AWAITING REQUEST";
      verifyState.className = "badge info";
    }
  } finally {
    verifyBusy = false;
    if (pendingVerify) { const p = pendingVerify; pendingVerify = null; driveVerify(p); }
  }
}

function addShadowRowReal(ev) {
  const conf = ev.shadow ? ev.shadow.conf : 70;
  const signal = ev.shadow ? ev.shadow.signal : "unsigned automation";
  const timeCell = cell(new Date(ev.t).toISOString().slice(11, 19), "mono dim");
  const liveTag = document.createElement("div");
  liveTag.setAttribute("style", "font-size:9px;letter-spacing:.1em;color:var(--green)");
  liveTag.textContent = "LIVE";
  timeCell.appendChild(liveTag);
  const tr = row([
    timeCell,
    cell(ev.ip, "mono"),
    cell(ev.ua || "(none)", "dim", "font-size:11px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"),
    cell(signal),
    badgeCell(conf + "%", conf > 90 ? "bad" : "warn"),
  ]);
  const body = $("#shadow-body");
  body.prepend(tr);
  while (body.children.length > 40) body.lastChild.remove();
}

function applySnapshot(s) {
  live.since = s.since;
  const bv = s.byVerdict || {};
  live.valid = bv.valid || 0;
  live.invalid = bv.invalid || 0;
  live.unresolved = bv.unresolved || 0;
  live.total = s.total || 0;
  const bk = s.byKind || {};
  live.signed = bk.signed || 0;
  live.shadow = bk.shadow || 0;
  live.known = bk.known || 0;
  live.human = bk.human || 0;
  live.tool = bk.tool || 0;
  if (s.signals) {
    // raw server counters only — these are rendered by renderKpis() in
    // live mode. Simulated KPI state (kpi.*) is never mixed with them.
    live.signals = s.signals;
  }
  if (!liveMode) { liveMode = true; enterLiveMode(); }
  renderKpis();
  setPill(`Live Capture · ${live.total} events`, "live");
}

/* Bounded dedupe: a reconnect or a replayed frame must not double-count.
   Keyed on the event's full identity; capped at 500 keys. */
const seenEvents = new Set();
function eventKey(ev) {
  return [ev.t, ev.kind, ev.method, ev.path, ev.status, ev.ms, ev.ua, ev.ip].join("|");
}

function ingestReal(ev) {
  if (!liveMode) { liveMode = true; enterLiveMode(); }
  const key = eventKey(ev);
  if (seenEvents.has(key)) return; // duplicate frame — never counted twice
  seenEvents.add(key);
  if (seenEvents.size > 500) {
    const first = seenEvents.values().next().value;
    seenEvents.delete(first);
  }
  live.total += 1;
  live[ev.kind] = (live[ev.kind] || 0) + 1;
  if (ev.signed && ev.signed.verdict && Object.prototype.hasOwnProperty.call(live, ev.signed.verdict)) {
    live[ev.signed.verdict] += 1;
  }
  pushEvent({
    t: ev.t || Date.now(),
    kind: ev.kind,
    method: ev.method || "GET",
    path: ev.path || "/",
    agent: (ev.agent && ev.agent.name) || ev.ua || "—",
    status: ev.status || 200,
    ms: Math.round(ev.ms || 0),
    sig: ev.signed && ev.signed.present ? ev.signed.verdict || "unresolved" : null,
    source: ev.source || "http",
  });
  renderKpis();
  setPill(`Live Capture · ${live.total} events`, "live");
  renderRealHeaders(ev);
  driveVerify(ev);
  if (ev.kind === "shadow") addShadowRowReal(ev);
  applyRealSignals(ev);
}

/* Panels 04–09 consume real server-derived signals instead of only
   simulating: IPI injections, trajectory-guard halts, MCP tool calls, revenue. */
function applyRealSignals(ev) {
  const sg = ev.signals;
  if (!sg) return;
  live.signals = live.signals || { ipi: 0, traj: 0, toolCalls: 0, revenue: 0 };

  if (sg.ipi) {
    live.signals.ipi++;
    addIpiRowReal(ev, sg.ipi);
  }
  if (sg.traj) {
    live.signals.traj++;
    // the trajectory console keeps running its SIM loop, so a real signal
    // must announce itself as live instead of blending in
    addTrace("ANOMALY", "LIVE · " + sg.traj, true);
    const st = $("#guard-state");
    if (st) { st.textContent = "Guard: HALT ISSUED"; st.className = "badge bad"; setTimeout(() => { st.textContent = "Guard: ARMED"; st.className = "badge ok"; }, 3200); }
  }
  if (sg.toolCall) {
    live.signals.toolCalls++;
    addMcpRowReal(ev);
  }
  if (sg.revenue) {
    live.signals.revenue += sg.revenue;
  }
  renderKpis();
  // Panels whose CONTENT becomes fully real are flipped to LIVE.
  // #chart-revenue and #trace-stream keep simulated content, so they
  // stay tagged SIM — only their inputs get a clearly marked live line.
  markPanelLive("#ipi-body");
  markPanelLive("#mcp-body");
}

/* flip a panel's SIM tag to LIVE when real data starts arriving */
function markPanelLive(sel) {
  const el = $(sel);
  if (el) feedTag(el, "LIVE");
}

function addIpiRowReal(ev, vector) {
  const tr = row([
    cell(new Date(ev.t).toISOString().slice(11, 19), "mono dim"),
    cell(ev.path || "—", "mono dim", "font-size:11px"),
    cell(vector),
    cell((ev.ua || "(none)").slice(0, 80), "mono", "font-size:11px;color:var(--amber)"),
    badgeCell("BLOCKED", "bad"),
  ]);
  const body = $("#ipi-body");
  if (!body) return;
  body.prepend(tr);
  while (body.children.length > 40) body.lastChild.remove();
  // panel head shows the real signal count instead of the sim "/ hr" drift
  const ir = $("#ipi-rate");
  if (ir) ir.textContent = fmtInt((live.signals && live.signals.ipi) || 0) + " flagged";
}

function addMcpRowReal(ev) {
  const ok = ev.status < 400;
  const tr = row([
    cell(new Date(ev.t).toISOString().slice(11, 19), "mono dim"),
    cell(ev.kind, "mono"),
    cell(ev.path || "—", "mono", "color:var(--cyan)"),
    cell(JSON.stringify({ ua: (ev.ua || "").slice(0, 40) }), "mono dim", "font-size:11px"),
    badgeCell("live", "vio"),
    badgeCell(ok ? "200 · structured" : ev.status, ok ? "ok" : "bad"),
    cell(Math.round(ev.ms || 0) + " ms", "mono"),
    cell("—", "mono dim", "font-size:11px"),
  ]);
  registerMcpRow(tr, {
    source: "live", domain: ev.kind, tool: ev.path || "—",
    payload: { ua: (ev.ua || "").slice(0, 40), method: ev.method, status: ev.status },
    schema: null, // no registry contract for live traffic → inferred in the modal
    schemaLabel: "inferred",
    ok, result: ok ? "200 · structured" : String(ev.status),
    latency: Math.round(ev.ms || 0) + " ms",
  });
  const body = $("#mcp-body");
  if (!body) return;
  body.prepend(tr);
  while (body.children.length > 40) body.lastChild.remove();
  // ledger head counts REAL invocations only (sim counters reset on seize)
  mcpAll++; if (ok) mcpOk++;
  const md = $("#mcp-discovered");
  if (md) md.textContent = mcpAll + " discovered";
  const ms = $("#mcp-success");
  if (ms) ms.textContent = (mcpOk / mcpAll * 100).toFixed(1) + "% success";
}

function connectCapture() {
  if (!/^https?:$/.test(location.protocol)) return; // file:// → simulator only
  let es;
  try { es = new EventSource("/events"); } catch (e) { return; }
  es.onmessage = (m) => {
    let d;
    try { d = JSON.parse(m.data); } catch (e) { return; }
    if (d && d.type === "snapshot") applySnapshot(d);
    else if (d && d.t) ingestReal(d);
  };
  es.onopen = () => setPill(liveMode ? `Live Capture · ${live.total} events` : "Capture linked…", "live");
  es.onerror = () => setPill("Capture reconnecting…", "warn");
}

applySourceState();
connectCapture();
