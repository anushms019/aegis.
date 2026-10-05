/* build.js — regenerates app.js (from src/*.js) and index.html (from app.js + styles.css).
   Usage: node build.js
   Sources: src/*.js  → app.js bundle → index.html
            styles.css               → index.html
   Function replacers are used deliberately: string replacers would interpret
   $$ / $& / $' sequences inside the JS payload and corrupt it. */
"use strict";
const fs = require("fs");
const path = require("path");

/* ── 1. bundle src/*.js → app.js ─────────────────────────── */
const SRC_DIR = path.join(__dirname, "src");
if (fs.existsSync(SRC_DIR)) {
  const parts = fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8"));
  if (!parts.length) {
    console.error("ERROR: src/ has no .js modules — aborting.");
    process.exit(1);
  }
  // each module already ends with exactly one newline, so a plain join is lossless
  fs.writeFileSync(path.join(__dirname, "app.js"), parts.join(""));
}

/* ── 2. inline app.js + styles.css into index.html ───────── */
const index = path.join(__dirname, "index.html");
let html = fs.readFileSync(index, "utf8");
const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

if (!/<style>[\s\S]*?<\/style>/.test(html) || !/<script>[\s\S]*?<\/script>/.test(html)) {
  console.error("ERROR: no <style>/<script> slots found in index.html — aborting.");
  process.exit(1);
}
html = html.replace(/<style>[\s\S]*?<\/style>/, () => "<style>\n" + css + "\n</style>");
html = html.replace(/<script>[\s\S]*?<\/script>/, () => "<script>\n" + js + "\n</script>");
if (html.includes("styles.css") || html.includes('src="app.js"')) {
  console.error("ERROR: leftover external references found — aborting.");
  process.exit(1);
}
fs.writeFileSync(index, html);
console.log("app.js bundled from src/:", fs.statSync(path.join(__dirname, "app.js")).size, "bytes");
console.log("index.html rebuilt:", html.length, "bytes");
