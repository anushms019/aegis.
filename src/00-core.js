/* ═══════════════════════════════════════════════════════════════
   AEGIS — Global AI Agent Observability Console
   Simulated telemetry engine: live feed, charts, map, trace stream
   ═══════════════════════════════════════════════════════════════ */
"use strict";

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const rnd = (a, b) => a + Math.random() * (b - a);
const rndi = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtMoney = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nowStamp = () => new Date().toISOString().slice(11, 23);
const escHtml = (s) => String(s ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ─── live capture state (fed by the SSE module at the end of this file) ─── */
let liveMode = false;      // true once a real event source is attached
let labelsMarked = false;
const live = { total: 0, signed: 0, shadow: 0, known: 0, human: 0, tool: 0, valid: 0, invalid: 0, unresolved: 0, since: null, signals: null };
let pendingVerify = null;

