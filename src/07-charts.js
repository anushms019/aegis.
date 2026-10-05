/* ─────────────── Canvas chart helpers ──────────────────── */
function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300;
  // Pin the authored height once: cv.height (the attribute) is overwritten below,
  // so reading it back would compound by dpr on every redraw when dpr > 1.
  if (!cv.dataset.baseH) cv.dataset.baseH = cv.getAttribute("height") || "150";
  const h = parseInt(cv.dataset.baseH, 10) || 150;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.height = h + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
function gridLines(ctx, w, h, rows = 4) {
  ctx.strokeStyle = "rgba(29,36,56,.8)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= rows; i++) {
    const y = (h / rows) * i + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
}

/* histogram: isTrusted true/false */
function drawIsTrusted() {
  const { ctx, w, h } = setupCanvas($("#chart-istrusted"));
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h);
  const trusted = [62, 64, 63, 66, 65, 67, 66, 68, 71, 74, 78, 82];
  const synthetic = [38, 36, 37, 34, 35, 33, 34, 32, 29, 26, 22, 18];
  const bw = w / trusted.length;
  trusted.forEach((v, i) => {
    const hh = (v / 100) * (h - 16);
    ctx.fillStyle = "rgba(61,255,158,.75)";
    ctx.fillRect(i * bw + 2, h - hh, bw - 4, hh);
    const sh = (synthetic[i] / 100) * (h - 16);
    ctx.fillStyle = "rgba(255,84,112,.7)";
    ctx.fillRect(i * bw + 2, h - sh, bw - 4, sh);
  });
  ctx.font = "10px monospace";
  ctx.fillStyle = "#3dff9e"; ctx.fillText("isTrusted=true", 6, 12);
  ctx.fillStyle = "#ff5470"; ctx.fillText("isTrusted=false", 6, 26);
}

/* line: trajectory entropy */
let entropySeries = Array.from({ length: 40 }, () => rnd(2.4, 4.2));
function drawEntropy() {
  const { ctx, w, h } = setupCanvas($("#chart-entropy"));
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h);
  const yFor = (v) => h - ((v - 1.5) / 3.5) * h;
  ctx.fillStyle = "rgba(61,255,158,.08)";
  ctx.fillRect(0, yFor(4.1), w, yFor(3.4) - yFor(4.1));
  ctx.strokeStyle = "#37e6d4"; ctx.lineWidth = 1.6;
  ctx.beginPath();
  entropySeries.forEach((v, i) => {
    const x = (i / (entropySeries.length - 1)) * w;
    i === 0 ? ctx.moveTo(x, yFor(v)) : ctx.lineTo(x, yFor(v));
  });
  ctx.stroke();
  ctx.font = "10px monospace";
  ctx.fillStyle = "#7c87a8"; ctx.fillText("human band 3.4–4.1", 6, yFor(4.1) - 4);
}
setInterval(() => {
  entropySeries.push(rnd(2.35, 2.75));
  entropySeries.shift();
  drawEntropy();
}, 1400);

/* bar: thinking pause per model */
const pauseModels = [
  ["GPT-class", 840, "var(--violet)"],
  ["Claude-class", 760, "var(--blue)"],
  ["Gemini-class", 690, "var(--cyan)"],
  ["Local 7B", 210, "var(--amber)"],
];
function drawPause() {
  const { ctx, w, h } = setupCanvas($("#chart-pause"));
  ctx.clearRect(0, 0, w, h);
  gridLines(ctx, w, h);
  const max = 1000;
  const bw = w / pauseModels.length;
  pauseModels.forEach(([name, ms, color], i) => {
    const jitter = ms + rnd(-45, 45);
    const hh = (jitter / max) * (h - 30);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(i * bw + bw * 0.2, h - hh, bw * 0.6, hh);
    ctx.globalAlpha = 1;
    ctx.font = "10px monospace";
    ctx.fillStyle = "#7c87a8";
    ctx.textAlign = "center";
    ctx.fillText(name, i * bw + bw / 2, h - 4);
    ctx.fillStyle = "#dbe2f5";
    ctx.fillText(Math.round(jitter) + "ms", i * bw + bw / 2, h - hh - 5);
    ctx.textAlign = "left";
  });
}
drawIsTrusted(); drawEntropy(); drawPause();
window.addEventListener("resize", () => { drawIsTrusted(); drawEntropy(); drawPause(); drawContext(); drawCep(); drawRevenue(); });

