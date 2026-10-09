/* ───────────────────────── KPIs ────────────────────────── */
/* Simulated KPI state — ONLY ever rendered in simulation mode.
   In live mode renderKpis() reads the real counters in `live`
   (fed by applySnapshot/ingestReal); nothing here may touch a
   live-rendered value, and no hardcoded baseline is ever added
   to a live signal. */
const kpi = {
  agents:  184392,
  signed:  0.638,
  shadow:  7412,
  anom:    318,
  ipi:     1247,
  rev:     84921.55,
};

function renderKpis() {
  if (liveMode) {
    // real counters from the capture server (absolute snapshot values,
    // kept in sync incrementally by ingestReal — never simulated)
    $("#kpi-agents").textContent = fmtInt(live.total);
    $("#kpi-signed").textContent = live.total ? ((live.signed / live.total) * 100).toFixed(1) + "%" : "0%";
    $("#kpi-shadow").textContent = fmtInt(live.shadow);
    const sd = $("#kpi-signed-d");
    if (sd) sd.textContent = `${live.valid} valid · ${live.invalid} invalid · ${live.unresolved} pending`;
    // verification panel counters track real verdicts in live mode
    if ($("#jwks-n")) $("#jwks-n").textContent = fmtInt(live.signed);
    if ($("#jwks-ok")) $("#jwks-ok").textContent = fmtInt(live.valid);
    if ($("#jwks-bad")) $("#jwks-bad").textContent = fmtInt(live.invalid);
    // signal cards: raw server-side signal counters since server start.
    // live.signals comes straight from the snapshot — no simulated
    // baseline (the old `1247 + signals.ipi` mix) is added.
    const sg = live.signals || {};
    $("#kpi-anom").textContent = fmtInt(sg.trajad || 0);
    $("#kpi-ipi").textContent = fmtInt(sg.ipi || 0);
    $("#kpi-rev").textContent = fmtMoney(sg.revenue || 0);
  } else {
    // simulation mode: every value below is simulated and its label
    // is marked "· SIM" by applySourceState()
    $("#kpi-agents").textContent = fmtInt(kpi.agents);
    $("#kpi-signed").textContent = (kpi.signed * 100).toFixed(1) + "%";
    $("#kpi-shadow").textContent = fmtInt(kpi.shadow);
    $("#kpi-anom").textContent = fmtInt(kpi.anom);
    $("#kpi-ipi").textContent = fmtInt(kpi.ipi);
    $("#kpi-rev").textContent = fmtMoney(kpi.rev);
  }
}
/* Delta lines: factual descriptions of what the number is. The old
   hardcoded trend percentages ("▲ 4.7% vs prior 24h", "▲ 32% YoY", …)
   claimed measurements the app does not make — removed everywhere;
   live mode clears them via markLabelsLive(). */
$("#kpi-agents-d").textContent = "simulated ingest counter";
$("#kpi-signed-d").textContent = "signed ÷ captured (simulated)";
$("#kpi-shadow-d").textContent = "simulated detections";
$("#kpi-anom-d").textContent = "simulated halts";
$("#kpi-ipi-d").textContent = "simulated payloads/hr";
$("#kpi-rev-d").textContent = "simulated settle volume";
renderKpis();

/* Simulation drift — simulation mode ONLY. In live mode these cards
   render live.signals, so a random walk must never touch them. */
setInterval(() => {
  if (liveMode) return;
  kpi.agents += rndi(3, 40);
  kpi.signed = clamp(kpi.signed + rnd(-0.001, 0.0011), 0.55, 0.78);
  if (Math.random() < 0.55) kpi.shadow += rndi(0, 4);
  if (Math.random() < 0.35) kpi.anom += 1;
  if (Math.random() < 0.6)  kpi.ipi  += rndi(0, 6);
  kpi.rev += rnd(2, 60);
  renderKpis();
}, 2000);
