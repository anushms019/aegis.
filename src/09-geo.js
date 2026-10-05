/* ─────────────────────── GEO panels ────────────────────── */
const citations = [
  ["yourbrand.com", 64, "linear-gradient(90deg,var(--cyan),var(--blue))"],
  ["competitor-a.io", 51, "linear-gradient(90deg,var(--blue),var(--violet))"],
  ["competitor-b.co", 44, "linear-gradient(90deg,var(--violet),var(--pink))"],
  ["wiki-reference.org", 38, "linear-gradient(90deg,var(--amber),var(--red))"],
  ["forum-thread.net", 27, "linear-gradient(90deg,var(--green),var(--cyan))"],
];
$("#citation-bars").innerHTML = citations
  .map(
    ([n, v, g]) => `<div class="bar-row">
      <span class="name">${n}</span>
      <div class="track"><div class="fill" style="width:${v}%;background:${g}"></div></div>
      <span class="num">${v}%</span>
    </div>`
  )
  .join("");
$("#geo-lift").textContent = "+38% GEO uplift";

const cepData = [42, 55, 61, 58, 72, 80, 77, 88, 92];
function drawCep() {
  const cv = $("#chart-cep");
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h);
  const bw = w / cepData.length;
  cepData.forEach((v, i) => {
    const hh = (v / 100) * (h - 24);
    const g = ctx.createLinearGradient(0, h - hh, 0, h);
    g.addColorStop(0, "#37e6d4");
    g.addColorStop(1, "rgba(77,157,255,.35)");
    ctx.fillStyle = g;
    ctx.fillRect(i * bw + 3, h - hh, bw - 6, hh);
  });
  ctx.font = "10px monospace";
  ctx.fillStyle = "#7c87a8";
  ctx.fillText("prompt contexts · 8-week trend", 4, 12);
}
drawCep();

