/* ─────────────────────── world map ─────────────────────── */
const MAP_NODES = [
  { x: 138, y: 108, label: "us-west",  region: "NA",    base: 4200, threat: false },
  { x: 196, y: 120, label: "us-east",  region: "NA",    base: 5100, threat: false },
  { x: 210, y: 250, label: "sa-east",  region: "LATAM", base: 980,  threat: false },
  { x: 396, y: 96,  label: "eu-west",  region: "EMEA",  base: 3800, threat: false },
  { x: 432, y: 112, label: "eu-central", region: "EMEA", base: 2600, threat: false },
  { x: 430, y: 210, label: "me-central", region: "EMEA", base: 740,  threat: true  },
  { x: 470, y: 250, label: "af-south", region: "EMEA",  base: 410,  threat: false },
  { x: 566, y: 120, label: "ap-north", region: "APAC",  base: 3300, threat: false },
  { x: 572, y: 190, label: "ap-south", region: "APAC",  base: 2900, threat: false },
  { x: 648, y: 148, label: "ap-east",  region: "APAC",  base: 4700, threat: false },
  { x: 678, y: 230, label: "ap-se",    region: "APAC",  base: 1600, threat: false },
  { x: 700, y: 312, label: "au-east",  region: "APAC",  base: 890,  threat: false },
];

const nodesG = $("#map-nodes");
MAP_NODES.forEach((n, i) => {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "node" + (n.threat ? " threat" : ""));
  g.innerHTML = `
    <circle class="halo" cx="${n.x}" cy="${n.y}" r="3" style="animation-delay:${(i * 0.31).toFixed(2)}s"/>
    <circle class="core" cx="${n.x}" cy="${n.y}" r="${n.base > 3000 ? 4 : 3}"/>
    <text class="lbl" x="${n.x + 7}" y="${n.y + 3}">${n.label}</text>`;
  nodesG.appendChild(g);
  n.el = g;
});

const regions = [
  { name: "NA",    color: "var(--blue)",   share: 39.4, live: 5100 },
  { name: "APAC",  color: "var(--cyan)",   share: 40.1, live: 5400 },
  { name: "EMEA",  color: "var(--violet)", share: 17.2, live: 2300 },
  { name: "LATAM", color: "var(--amber)",  share: 2.1,  live: 290 },
  { name: "ANZ",   color: "var(--green)",  share: 1.2,  live: 170 },
];

function renderRegionLegend() {
  $("#map-rate").textContent = fmtInt(regions.reduce((s, r) => s + r.live, 0)) + " req/s";
  $("#region-legend").innerHTML = regions
    .map((r) => `<span>${r.name} <b style="color:${r.color}">${fmtInt(r.live)} r/s</b></span>`)
    .join("");
}

function renderRegionBars() {
  $("#region-bars").innerHTML = regions
    .map(
      (r) => `<div class="bar-row">
        <span class="name">${r.name}</span>
        <div class="track"><div class="fill" style="width:${r.share}%;background:${r.color}"></div></div>
        <span class="num">${r.share.toFixed(1)}%</span>
      </div>`
    )
    .join("");
}
renderRegionBars();
renderRegionLegend();

setInterval(() => {
  regions.forEach((r) => (r.live = Math.max(60, r.live + rnd(-90, 95))));
  const total = regions.reduce((s, r) => s + r.live, 0);
  regions.forEach((r) => (r.share = +((r.live / total) * 100).toFixed(1)));
  renderRegionBars();
  renderRegionLegend();
  MAP_NODES.forEach((n) => {
    const r = regions.find((x) => x.name === n.region) || regions[4];
    const s = clamp(r.live / 1400, 0.6, 4.4);
    n.el.querySelector(".core").setAttribute("r", s.toFixed(1));
  });
}, 2500);

