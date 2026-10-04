/* build.js — regenerates the self-contained index.html from sources.
   Usage: node build.js
   Sources: styles.css + app.js + the <style>/<script> slots already in index.html.
   Function replacers are used deliberately: string replacers would interpret
   $$ / $& / $' sequences inside the JS payload and corrupt it. */
"use strict";
const fs = require("fs");

let html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const js = fs.readFileSync("app.js", "utf8");

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
fs.writeFileSync("index.html", html);
console.log("index.html rebuilt:", html.length, "bytes");
