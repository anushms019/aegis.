/* ─────────────────────── WebMCP ledger ─────────────────── */
const MCP_TOOLS = [
  ["shop.example", "product.search", { q: "wireless anc headphones" }, "JSON Schema ✓"],
  ["shop.example", "cart.addItem", { sku: "A-8821", qty: 1 }, "JSON Schema ✓"],
  ["airline.example", "fare.quote", { from: "SFO", to: "NRT" }, "JSON Schema ✓"],
  ["bank.example", "account.balance", { acct: "****4412" }, "JSON Schema ✓"],
  ["docs.example", "search.internal", { q: "rate limits" }, "JSON Schema ✓"],
  ["realestate.example", "listing.filter", { max: 850000, beds: 3 }, "JSON Schema ✓"],
  ["travel.example", "hotel.avail", { city: "TYO", nights: 4 }, "JSON Schema ✓"],
  ["auto.example", "dealer.quote", { vin: "…9F21" }, "JSON Schema ✓"],
];

/* Declared request JSON-Schemas for the registry tools (draft 2020-12
   shape). The inspector shows these verbatim next to the payload and
   validates the payload against them — including on 422 rows, where the
   ledger deliberately drops a required field to simulate a violation. */
const MCP_SCHEMAS = {
  "product.search": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["q"],
    properties: {
      q: { type: "string", minLength: 1, description: "free-text product query" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  "cart.addItem": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["sku", "qty"],
    properties: {
      sku: { type: "string", minLength: 1, description: "stock-keeping unit" },
      qty: { type: "integer", minimum: 1, maximum: 99 },
    },
  },
  "fare.quote": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["from", "to"],
    properties: {
      from: { type: "string", pattern: "^[A-Z]{3}$", description: "IATA origin" },
      to: { type: "string", pattern: "^[A-Z]{3}$", description: "IATA destination" },
    },
  },
  "account.balance": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["acct"],
    properties: {
      acct: { type: "string", minLength: 4, description: "account reference" },
      currency: { type: "string", enum: ["USD", "EUR", "JPY"] },
    },
  },
  "search.internal": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["q"],
    properties: {
      q: { type: "string", minLength: 1 },
      top_k: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  "listing.filter": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["max"],
    properties: {
      max: { type: "number", minimum: 50000, maximum: 5000000, description: "max price" },
      beds: { type: "integer", minimum: 0, maximum: 20 },
    },
  },
  "hotel.avail": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["city", "nights"],
    properties: {
      city: { type: "string", minLength: 3 },
      nights: { type: "integer", minimum: 1, maximum: 14 },
    },
  },
  "dealer.quote": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false, required: ["vin"],
    properties: {
      vin: { type: "string", minLength: 8, description: "vehicle identification number" },
    },
  },
};

/* JSON value → JSON-Schema type name (integer ⊂ number). */
function mcpTypeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

/* Infer a schema from a live payload when the registry declares none —
   the inspector labels these rows "inferred" rather than pretending the
   tool published a contract. */
function inferMcpSchema(payload) {
  const properties = {};
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const k of Object.keys(payload)) properties[k] = { type: mcpTypeName(payload[k]) };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
    "x-inferred": true,
  };
}

/* Validate a payload against a (subset of a) JSON-Schema and return the
   field-by-field diff: { ok, findings: [{ path, expected, actual, ok }] }.
   Supported keywords: type, required, properties, additionalProperties,
   enum, pattern, minLength, minimum, maximum. Self-contained on purpose —
   tests extract this function from the bundle and exercise it directly. */
function validateAgainstSchema(payload, schema) {
  const findings = [];
  const show = (v) => {
    let s;
    try { s = JSON.stringify(v); } catch (_) { s = String(v); }
    return s === undefined ? String(v) : s.length > 64 ? s.slice(0, 61) + "…" : s;
  };
  const fail = (path, expected, actual) => findings.push({ path, expected, actual, ok: false });
  const pass = (path, expected, actual) => findings.push({ path, expected, actual, ok: true });
  const typeOk = (value, type) => {
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "null") return value === null;
    return typeof value === type;
  };

  if (!schema || schema.type !== "object" || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, findings: [{ path: "(root)", expected: "object payload", actual: show(payload), ok: false }] };
  }
  const props = schema.properties || {};
  const additional = schema.additionalProperties !== false;

  for (const key of schema.required || []) {
    if (!(key in payload)) fail(key, "required", "(missing)");
    else pass(key, "required", "present");
  }
  for (const [key, value] of Object.entries(payload)) {
    const spec = props[key];
    if (!spec) {
      if (additional) pass(key, "additional (allowed)", show(value));
      else fail(key, "not in schema (additionalProperties: false)", show(value));
      continue;
    }
    const expected = spec.type + (spec.enum ? " ∈ [" + spec.enum.join(",") + "]"
      : spec.pattern ? " ~ /" + spec.pattern + "/"
      : spec.minimum !== undefined && spec.maximum !== undefined ? " " + spec.minimum + "…" + spec.maximum
      : spec.minimum !== undefined ? " ≥ " + spec.minimum
      : spec.minLength !== undefined ? " len ≥ " + spec.minLength : "");
    const actual = mcpTypeName(value) + " " + show(value);
    if (!typeOk(value, spec.type)) { fail(key, expected, actual); continue; }
    if (spec.enum && !spec.enum.includes(value)) { fail(key, expected, actual); continue; }
    if (spec.pattern && !(new RegExp(spec.pattern).test(String(value)))) { fail(key, expected, actual); continue; }
    if (spec.minLength !== undefined && String(value).length < spec.minLength) { fail(key, expected, actual); continue; }
    if (spec.minimum !== undefined && value < spec.minimum) { fail(key, expected, actual); continue; }
    if (spec.maximum !== undefined && value > spec.maximum) { fail(key, expected, actual); continue; }
    pass(key, expected, actual);
  }
  for (const key of Object.keys(props)) {
    if (!(key in payload) && !(schema.required || []).includes(key)) {
      pass(key, "optional (absent)", "(omitted)");
    }
  }
  return { ok: findings.every((f) => f.ok), findings };
}

let mcpOk = 0, mcpAll = 0;
function addMcpRow() {
  const [domain, tool, params, schema] = pick(MCP_TOOLS);
  const ok = Math.random() < 0.91;
  const lat = rndi(38, 640);
  mcpAll++; if (ok) mcpOk++;
  // A 422 row is a real violation: drop a required field from the payload
  // (cloned, never mutating the MCP_TOOLS template) so the inspector's
  // diff agrees with the Result column instead of contradicting it.
  const spec = MCP_SCHEMAS[tool];
  const payload = { ...params };
  if (!ok && spec && spec.required && spec.required.length) delete payload[spec.required[0]];
  const tr = row([
    cell(nowStamp().slice(0, 8), "mono dim"),
    cell(domain, "mono"),
    cell(tool, "mono", "color:var(--cyan)"),
    cell(JSON.stringify(payload), "mono dim", "font-size:11px"),
    badgeCell(schema, "vio"),
    badgeCell(ok ? "200 · structured" : "422 · schema violation", ok ? "ok" : "bad"),
    cell(lat + " ms", "mono"),
    cell(ok ? JSON.stringify({ result: "…" }).slice(0, 22) : "—", "mono dim", "font-size:11px"),
  ]);
  registerMcpRow(tr, {
    source: "sim", domain, tool,
    payload, schema: MCP_SCHEMAS[tool] || null, schemaLabel: schema,
    ok, result: ok ? "200 · structured" : "422 · schema violation",
    latency: lat + " ms",
  });
  const body = $("#mcp-body");
  body.prepend(tr);
  while (body.children.length > 40) body.lastChild.remove();
  $("#mcp-discovered").textContent = mcpAll + " discovered";
  $("#mcp-success").textContent = ((mcpOk / mcpAll) * 100).toFixed(1) + "% success";
}

/* ── schema inspector modal ────────────────────────────── */
/* Rows carry their data in a WeakMap (never in the DOM): payloads and
   schemas are structured objects, and attributes would force them through
   an HTML serializer. Rows are keyboard-operable like buttons. */
const mcpRows = new WeakMap();
let mcpModalReturnFocus = null;

function registerMcpRow(tr, record) {
  mcpRows.set(tr, record);
  tr.tabIndex = 0;
  tr.setAttribute("aria-label",
    `Inspect ${record.tool} — open JSON-Schema inspector`);
  return tr;
}

function mcpFindingsTable(validate) {
  const tbody = $("#mcp-modal-diff");
  tbody.replaceChildren();
  for (const f of validate.findings) {
    const tr = row([
      cell(f.path, "field"),
      cell(f.expected, "dim"),
      cell(f.actual, ""),
      cell(f.ok ? "✓ match" : "✗ violated", ""),
    ]);
    tr.lastChild.style.color = f.ok ? "var(--green)" : "var(--red)";
    tbody.appendChild(tr);
  }
}

function openMcpInspector(tr) {
  const rec = mcpRows.get(tr);
  if (!rec) return;
  const modal = $("#mcp-modal");
  const schema = rec.schema || inferMcpSchema(rec.payload);
  const validate = validateAgainstSchema(rec.payload, schema);

  $("#mcp-modal-domain").textContent = rec.domain + " · WebMCP tool call";
  $("#mcp-modal-title").textContent = rec.tool;
  $("#mcp-modal-source").textContent = rec.source === "live" ? "LIVE" : "SIM";
  $("#mcp-modal-source").className = "badge " + (rec.source === "live" ? "cyan" : "vio");
  $("#mcp-modal-payload").textContent = JSON.stringify(rec.payload, null, 2);
  $("#mcp-modal-schema").textContent = JSON.stringify(schema, null, 2);

  const meta = $("#mcp-modal-meta");
  meta.replaceChildren();
  const line = document.createElement("div");
  const b = (t) => { const el = document.createElement("b"); el.textContent = t; return el; };
  line.append(b(rec.tool), " · ", rec.result || "—", " · ", String(rec.latency || "—"),
    " · schema ", rec.schema ? "declared by registry" : "inferred from payload");
  meta.appendChild(line);

  mcpFindingsTable(validate);

  const summary = $("#mcp-modal-summary");
  summary.replaceChildren();
  const badge = document.createElement("span");
  badge.className = "badge " + (validate.ok ? "ok" : "bad");
  badge.textContent = validate.ok ? "SCHEMA VALID" : "SCHEMA VIOLATION";
  const passed = validate.findings.filter((f) => f.ok).length;
  const text = document.createElement("span");
  text.className = "dim";
  text.textContent = `${passed}/${validate.findings.length} checks passed` +
    (validate.ok ? " — payload conforms to the declared contract"
                 : " — payload deviates from the contract (expect 422)");
  summary.append(badge, text);

  mcpModalReturnFocus = tr;
  modal.hidden = false;
  $("#mcp-modal-close").focus();
}

function closeMcpInspector() {
  const modal = $("#mcp-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (mcpModalReturnFocus && document.contains(mcpModalReturnFocus)) {
    mcpModalReturnFocus.focus();
  }
  mcpModalReturnFocus = null;
}

function initMcpInspector() {
  const body = $("#mcp-body");
  if (!body) return;
  const rowOf = (target) => {
    const tr = target && target.closest ? target.closest("tr") : null;
    return tr && mcpRows.has(tr) ? tr : null;
  };
  body.addEventListener("click", (e) => {
    const tr = rowOf(e.target);
    if (tr) openMcpInspector(tr);
  });
  body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = rowOf(e.target);
    if (tr) { e.preventDefault(); openMcpInspector(tr); }
  });
  const close = $("#mcp-modal-close");
  if (close) close.addEventListener("click", closeMcpInspector);
  const backdrop = $("#mcp-modal");
  if (backdrop) backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeMcpInspector();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMcpInspector();
  });
}

for (let i = 0; i < 8; i++) addMcpRow();
/* Simulated ledger rows pause while a live capture is attached —
   enterLiveMode() has cleared the tbody, and real rows arrive via
   addMcpRowReal(), so mocks can never mix into a live ledger. */
setInterval(() => { if (!liveMode) addMcpRow(); }, 3100);
initMcpInspector();
