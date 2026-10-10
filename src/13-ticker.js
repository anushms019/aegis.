/* ─────────────────────── ticker ────────────────────────── */
function buildTicker() {
  const items = [
    "<b>Web Bot Auth</b> verification pass rate 99.66%",
    "<span class='bad'>shadow agent</span> cluster: patched Chromium, reused canvas fingerprint",
    "<b>Trajectory guard</b> halted 3 trajectories in last hour",
    "<span class='warn'>IPI payloads ▲32% YoY</span> — JSON-LD abuse fastest-growing vector",
    "<b>Pay Per Crawl</b> settle volume " + fmtMoney(kpi.rev) + " today",
    "<b>WebMCP</b> tools discovered: " + fmtInt(mcpAll) + " this session",
    "APAC leads ingest share at 40.1% · NA 39.4% · EMEA 17.2%",
    "<span class='bad'>isTrusted spoofing</span> — detection theme this demo models",
    "<b>GEO</b> citation uplift +38% for structured-quote pages",
    "single-process ingest: HTTP → in-memory counters → SSE → dashboard",
  ];
  const line = items.join(" &nbsp;·&nbsp; ") + " &nbsp;·&nbsp; ";
  // editorial/demo content — always labeled so it can't read as telemetry
  $("#ticker-inner").innerHTML = "<span class='dim'>SIM</span> " + line + line;
}
buildTicker();
setInterval(buildTicker, 12000);

/* initial chart paint after layout settles */
requestAnimationFrame(() => { drawContext(); drawCep(); drawRevenue(); });

