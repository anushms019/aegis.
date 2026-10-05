/* ───────────────────── Pay-per-crawl ───────────────────── */
const PUBLISHERS = [
  ["newsgrid.io", "search summarization", "$0.0042"],
  ["datadump.dev", "model training", "$0.0110"],
  ["encyclopedia-x.org", "real-time RAG", "$0.0028"],
  ["marketwatch-pro.com", "real-time RAG", "$0.0091"],
  ["open-datasets.net", "model training", "$0.0067"],
  ["api-docs.cloud", "tool use", "$0.0019"],
];
$("#pub-body").innerHTML = PUBLISHERS.map(([p, u, b]) => {
  const rev = rndi(4200, 98000);
  return `<tr>
    <td><b>${p}</b></td>
    <td class="dim">${u}</td>
    <td class="mono">${b}</td>
    <td class="mono" style="color:var(--green)">${fmtMoney(rev)}</td>
  </tr>`;
}).join("");

let revenueSeries = Array.from({ length: 48 }, () => rnd(800, 2600));
let ppc200 = 842199, ppc402 = 118442;
function drawRevenue() {
  const cv = $("#chart-revenue");
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h, 5);
  const max = Math.max(...revenueSeries) * 1.12;
  const bw = w / revenueSeries.length;
  revenueSeries.forEach((v, i) => {
    const hh = (v / max) * (h - 10);
    const g = ctx.createLinearGradient(0, h - hh, 0, h);
    g.addColorStop(0, "#3dff9e");
    g.addColorStop(1, "rgba(61,255,158,.15)");
    ctx.fillStyle = g;
    ctx.fillRect(i * bw, h - hh, Math.max(2, bw - 2), hh);
  });
  ctx.font = "10px monospace";
  ctx.fillStyle = "#7c87a8";
  ctx.fillText("402 accept/settle events · $/5min", 6, 12);
}
function renderPpc() {
  $("#ppc-200").textContent = fmtInt(ppc200);
  $("#ppc-402").textContent = fmtInt(ppc402);
  $("#ppc-bid").textContent = "$0.0057 avg";
  $("#ppc-margin").textContent = "72.4%";
}
renderPpc(); drawRevenue();
setInterval(() => {
  revenueSeries.push(clamp(revenueSeries[revenueSeries.length - 1] + rnd(-260, 290), 500, 3400));
  revenueSeries.shift();
  ppc200 += rndi(40, 320);
  if (Math.random() < 0.7) ppc402 += rndi(5, 60);
  drawRevenue(); renderPpc();
}, 2200);

$$("[data-range]").forEach((b) =>
  b.addEventListener("click", () => {
    $$("[data-range]").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    const n = b.dataset.range === "1h" ? 48 : b.dataset.range === "24h" ? 96 : 168;
    revenueSeries = Array.from({ length: n }, () => rnd(700, 2800));
    drawRevenue();
  })
);

