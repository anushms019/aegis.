/* ───────────────────────── clock ───────────────────────── */
setInterval(() => {
  const d = new Date();
  $("#clock").textContent =
    d.toISOString().slice(0, 10) + " " + d.toTimeString().slice(0, 8) + " UTC";
}, 1000);

