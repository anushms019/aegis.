/* ───────────────────────── KPIs ────────────────────────── */
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
    // real counters from the capture server
    $("#kpi-agents").textContent = fmtInt(live.total);
    $("#kpi-signed").textContent = live.total ? ((live.signed / live.total) * 100).toFixed(1) + "%" : "0%";
    $("#kpi-shadow").textContent = fmtInt(live.shadow);
    const sd = $("#kpi-signed-d");
    if (sd) sd.textContent = `${live.valid} valid · ${live.invalid} invalid · ${live.unresolved} pending`;
    // verification panel counters track real verdicts in live mode
    if ($("#jwks-n")) $("#jwks-n").textContent = fmtInt(live.signed);
    if ($("#jwks-ok")) $("#jwks-ok").textContent = fmtInt(live.valid);
    if ($("#jwks-bad")) $("#jwks-bad").textContent = fmtInt(live.invalid);
  } else {
    $("#kpi-agents").textContent = fmtInt(kpi.agents);
    $("#kpi-signed").textContent = (kpi.signed * 100).toFixed(1) + "%";
    $("#kpi-shadow").textContent = fmtInt(kpi.shadow);
  }
  $("#kpi-anom").textContent   = fmtInt(kpi.anom);
  $("#kpi-ipi").textContent    = fmtInt(kpi.ipi);
  $("#kpi-rev").textContent    = fmtMoney(kpi.rev);
}
$("#kpi-agents-d").textContent = "▲ 4.7% vs. prior 24h";
$("#kpi-signed-d").textContent = "▲ 1.9 pts — Web Bot Auth adoption";
$("#kpi-shadow-d").textContent = "▲ 12.4% — stealth engine campaigns";
$("#kpi-anom-d").textContent   = "0.17% of trajectories halted";
$("#kpi-ipi-d").textContent    = "▲ 32% YoY (in-the-wild)";
$("#kpi-rev-d").textContent    = "▲ 9.2% — Pay Per Crawl beta";
renderKpis();

setInterval(() => {
  if (!liveMode) {
    kpi.agents += rndi(3, 40);
    kpi.signed = clamp(kpi.signed + rnd(-0.001, 0.0011), 0.55, 0.78);
    if (Math.random() < 0.55) kpi.shadow += rndi(0, 4);
  }
  if (Math.random() < 0.35) kpi.anom += 1;
  if (Math.random() < 0.6)  kpi.ipi  += rndi(0, 6);
  kpi.rev += rnd(2, 60);
  renderKpis();
}, 2000);

