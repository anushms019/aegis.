/* ─────────────────────── WebMCP ledger ─────────────────── */
const MCP_TOOLS = [
  ["shop.example", "product.search", { q: "wireless anc headphones" }, "JSON Schema ✓"],
  ["shop.example", "cart.addItem", { sku: "A-8821", qty: 1 }, "JSON Schema ✓"],
  ["airline.example", "fare.quote", { from: "SFO", to: "NRT" }, "JSON Schema ✓"],
  ["bank.example", "account.balance", { acct: "****4412" }, "JSON Schema ✓"],
  ["docs.example", "search.internal", { q: "rate limits" }, "JSON Schema ✓"],
  ["realestate.example", "listing.filter", { max: 850000, beds: 3 }, "JSON Schema ✓"],
  ["travel.example", "hotel.avail", { city: "TYO", nights: 4 }, "JSON Schema ✓"],
  ["auto.example", "dealer.quote", { vin: "…9F21" }, "JSON Schema ✓"],
];
let mcpOk = 0, mcpAll = 0;
function addMcpRow() {
  const [domain, tool, params, schema] = pick(MCP_TOOLS);
  const ok = Math.random() < 0.91;
  const lat = rndi(38, 640);
  mcpAll++; if (ok) mcpOk++;
  const tr = row([
    cell(nowStamp().slice(0, 8), "mono dim"),
    cell(domain, "mono"),
    cell(tool, "mono", "color:var(--cyan)"),
    cell(JSON.stringify(params), "mono dim", "font-size:11px"),
    badgeCell(schema, "vio"),
    badgeCell(ok ? "200 · structured" : "422 · schema violation", ok ? "ok" : "bad"),
    cell(lat + " ms", "mono"),
    cell(ok ? JSON.stringify({ result: "…" }).slice(0, 22) : "—", "mono dim", "font-size:11px"),
  ]);
  const body = $("#mcp-body");
  body.prepend(tr);
  while (body.children.length > 40) body.lastChild.remove();
  $("#mcp-discovered").textContent = mcpAll + " discovered";
  $("#mcp-success").textContent = ((mcpOk / mcpAll) * 100).toFixed(1) + "% success";
}
for (let i = 0; i < 8; i++) addMcpRow();
setInterval(addMcpRow, 3100);

