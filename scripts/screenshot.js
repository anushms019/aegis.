/* scripts/screenshot.js — capture dashboard screenshots for docs/
 *
 * Zero-dependency: drives a locally installed Chrome/Edge over the
 * Chrome DevTools Protocol using Node's built-in WebSocket.
 *
 * Usage:
 *   node scripts/screenshot.js <url> <out.png> [width] [height] [scrollToText] [--full]
 *
 * scrollToText: visible substring of an <h2> to scroll into view
 *               (omit to capture the top of the page).
 * --full: capture the entire scrollable page instead of the viewport.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error("no Chrome/Edge found — set CHROME=<path> and retry");
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve(JSON.parse(b)));
    });
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [url, out, wArg, hArg, scrollToText, ...flags] = process.argv.slice(2);
  if (!url || !out) {
    console.error("usage: node scripts/screenshot.js <url> <out.png> [w] [h] [scrollToText] [--full]");
    process.exit(2);
  }
  const width = Number(wArg) || 1440;
  const height = Number(hArg) || 900;
  const full = flags.includes("--full");
  const port = 9333 + Math.floor(Math.random() * 100);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-shot-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  const kill = () => {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
      else chrome.kill("SIGKILL");
    } catch (_) {}
    // Chrome may still hold handles briefly — best effort, never fail the run over cleanup.
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); return; }
      catch (_) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
    }
  };

  try {
    // wait for the DevTools endpoint
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await get(`http://127.0.0.1:${port}/json/list`);
        break;
      } catch (_) {
        await sleep(250);
      }
    }
    if (!targets) throw new Error("Chrome DevTools endpoint never came up");
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 2, mobile: false,
    });
    await send("Page.navigate", { url });
    await sleep(3500); // let SSE hydrate + charts animate

    if (scrollToText) {
      await send("Runtime.evaluate", {
        expression: `(() => {
          const h = [...document.querySelectorAll("h2")].find(x => x.textContent.toLowerCase().includes(${JSON.stringify(scrollToText.toLowerCase())}));
          if (h) { h.closest("section, .section, div")?.scrollIntoView(); h.scrollIntoView(); window.scrollBy(0, -70); }
        })()`,
      });
      await sleep(1200);
    }

    let params = { format: "png" };
    if (full) {
      const m = await send("Page.getLayoutMetrics");
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const shot = await send("Page.captureScreenshot", params);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`wrote ${out} (${fs.statSync(out).size} bytes${full ? ", full page" : ""})`);
    ws.close();
  } finally {
    kill();
  }
}

main().catch((e) => {
  console.error("screenshot failed:", e.message);
  process.exit(1);
});
