/* ───────────────────────── clock ─────────────────────────
   Date, time and timezone must agree. The previous version mixed a
   UTC date with a local time-of-day and labeled the result "UTC" —
   the three could contradict each other.
   All three fields now come from the same Date in the same zone
   (browser local time + the real IANA zone name). */
const CLOCK_ZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"; }
  catch (_) { return "local"; }
})();

function renderClock() {
  const el = $("#clock");
  if (!el) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  el.textContent =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${CLOCK_ZONE}`;
}
renderClock();
setInterval(renderClock, 1000);
