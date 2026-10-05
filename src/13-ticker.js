/* ─────────────────────── ticker ────────────────────────── */
function buildTicker() {
  const items = [
    "<b>Web Bot Auth</b> verification pass rate 99.66%",
    "<span class='bad'>shadow agent</span> cluster: patched Chromium, 9-region canvas persistence",
    "<b>TrajAD</b> halted 3 trajectories in last hour",
    "<span class='warn'>IPI payloads ▲32% YoY</span> — JSON-LD abuse fastest-growing vector",
    "<b>Pay Per Crawl</b> settle volume " + fmtMoney(kpi.rev) + " today",
    "<b>WebMCP</b> tools discovered: " + fmtInt(mcpAll) + " this session",
    "APAC leads ingest share at 40.1% · NA 39.4% · EMEA 17.2%",
    "<span class='bad'>isTrusted spoofing</span> defeated by trajectory entropy scoring",
    "<b>GEO</b> citation uplift +38% for structured-quote pages",
    "median ingest→dashboard latency 310ms across 42 edge PoPs",
  ];
  const line = items.join(" &nbsp;·&nbsp; ") + " &nbsp;·&nbsp; ";
  $("#ticker-inner").innerHTML = line + line;
}
buildTicker();
setInterval(buildTicker, 12000);

/* initial chart paint after layout settles */
requestAnimationFrame(() => { drawContext(); drawCep(); drawRevenue(); });

