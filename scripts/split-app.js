/* split-app.js — one-shot: split app.js into src/*.js modules.
   The reverse also runs: build.js concatenates src/*.js → app.js → index.html.
   Safe to re-run; it is idempotent (splits the current app.js). */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync("app.js", "utf8");
const lines = src.split("\n");

const marks = [];
for (let i = 0; i < lines.length; i++) {
  if (/^\/\* ═+/.test(lines[i]) || /^\/\* ─{4,} /.test(lines[i])) marks.push(i);
}
const keep = [];
for (const m of marks) if (!keep.length || m - keep[keep.length - 1] > 3) keep.push(m);

const NAMES = [
  "00-core", "01-clock", "02-kpis", "03-map", "04-verify", "05-registry",
  "06-shadow", "07-charts", "08-trajad", "09-geo", "10-webmcp", "11-ppc",
  "12-ipi", "13-ticker", "14-event-stream", "15-live-sse",
];

fs.mkdirSync("src", { recursive: true });
for (let i = 0; i < keep.length; i++) {
  const start = keep[i];
  const end = i + 1 < keep.length ? keep[i + 1] : lines.length;
  const chunk = lines.slice(start, end).join("\n");
  const name = NAMES[i] || `part-${i}`;
  // lossless: slice+join drops the newline that terminated the last line of
  // the slice, so every non-final chunk must put it back. The final chunk
  // keeps its own trailing newline (or lack of one) exactly as-is.
  const isLast = i + 1 >= keep.length;
  const out = isLast ? chunk : chunk + "\n";
  fs.writeFileSync(path.join("src", name + ".js"), out);
  console.log(`src/${name}.js  (${end - start} lines)`);
}
