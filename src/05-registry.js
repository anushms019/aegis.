/* ─────────────── Trusted Agent Registry ────────────────── */
const registry = AGENT_OPS.concat([
  { op: "Amazon",     agent: "Alexa-Index",   kid: "SHA256:1d70ce4b18…9a55" },
  { op: "Apple",      agent: "Siri-Crawler",  kid: "SHA256:aa34e12f76…02dc" },
  { op: "Mistral",    agent: "Le-Grabber",    kid: "SHA256:6ff0012bca…4410" },
  { op: "Cohere",     agent: "Command-Web",   kid: "SHA256:b812e77d34…71c8" },
]);
$("#registry-body").innerHTML = registry
  .map((r) => {
    const reqs = rndi(42000, 2900000);
    const status = Math.random() < 0.08 ? ["KEY ROTATION PENDING", "warn"] : ["VERIFIED", "ok"];
    return `<tr>
      <td><b>${r.op}</b></td>
      <td class="mono">${r.agent}</td>
      <td class="mono dim">${r.kid}</td>
      <td><span class="badge vio">Ed25519</span></td>
      <td class="mono dim" style="font-size:11px">/.well-known/…signatures-directory</td>
      <td class="mono">${fmtInt(reqs)}</td>
      <td><span class="badge ${status[1]}">${status[0]}</span></td>
    </tr>`;
  })
  .join("");
$("#registry-count").textContent = registry.length + " operators";

