/**
 * Backward-compatibility rules for contracts. A change is judged from the side of whoever did NOT make it:
 *
 *   direction "read"  (events, API responses): the owner WRITES, others READ. Readers break when the
 *                     owner loosens: a field disappears or may be missing, a type widens, a new enum value.
 *   direction "write" (commands, API requests): others WRITE, the owner READS. Writers break when the
 *                     owner tightens: a new required field, a removed enum value, a stricter pattern.
 *
 * Adding OPTIONAL fields is safe in both directions: every consumer is a tolerant reader (convention).
 * Severity: "breaking" (needs a new major version of the message/API), "warning" (review: may break
 * strict consumers), "safe".
 */

const RANK = { safe: 0, warning: 1, breaking: 2 };
export const worst = (findings) => findings.reduce((w, f) => (RANK[f.severity] > RANK[w] ? f.severity : w), "safe");

/** read: loosening breaks; write: tightening breaks. */
const onLoosen = (dir) => (dir === "read" ? "breaking" : "safe");
const onTighten = (dir) => (dir === "write" ? "breaking" : "safe");

// --------------------------------------------------------------------------------- normalisation
/** Resolve local $refs (OpenAPI components) and fold nullability into a type set. */
function normalise(schema, resolve, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema ?? {};
  let s = schema;
  while (s.$ref && resolve) {
    if (seen.has(s.$ref)) return { "x-cycle": s.$ref };
    seen = new Set([...seen, s.$ref]);
    s = { ...resolve(s.$ref), ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$ref")) };
  }
  s = { ...s };
  // OpenAPI 3.0 `nullable: true` and 3.1/pydantic `anyOf: [X, {type: "null"}]` both mean "X or null".
  if (s.nullable === true) {
    delete s.nullable;
    s.type = [...types(s), "null"];
  }
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) {
    const nonNull = union.filter((u) => !(u && u.type === "null"));
    if (nonNull.length === 1 && nonNull.length < union.length) {
      const inner = normalise(nonNull[0], resolve, seen);
      delete s.anyOf;
      delete s.oneOf;
      return { ...inner, ...s, type: [...new Set([...types(inner), "null"])] };
    }
  }
  return s;
}

function types(s) {
  if (s.type === undefined) return s.const !== undefined ? [typeof s.const === "number" ? "number" : typeof s.const] : [];
  return Array.isArray(s.type) ? [...s.type] : [s.type];
}

// --------------------------------------------------------------------------------- schema walker
/**
 * Compares two JSON Schemas (one message payload, request body or response body).
 * `resolve` dereferences "#/components/schemas/X" for OpenAPI; absent for message schemas.
 */
export function compareSchemas(oldRaw, newRaw, { direction, path = "", resolveOld, resolveNew }) {
  const out = [];
  const add = (p, change, severity) => out.push({ path: p || "(root)", change, severity });
  walk(oldRaw, newRaw, path);
  return out;

  function walk(oRaw, nRaw, p) {
    const o = normalise(oRaw, resolveOld);
    const n = normalise(nRaw, resolveNew);

    // ---- types
    const ot = types(o);
    const nt = types(n);
    if (ot.length && nt.length) {
      let widened = nt.filter((t) => !ot.includes(t));
      let narrowed = ot.filter((t) => !nt.includes(t));
      if (widened.includes("number") && narrowed.includes("integer")) {
        add(p, "integer widened to number", onLoosen(direction));
        widened = widened.filter((t) => t !== "number");
        narrowed = narrowed.filter((t) => t !== "integer");
      }
      if (widened.includes("integer") && narrowed.includes("number")) {
        add(p, "number narrowed to integer", onTighten(direction));
        widened = widened.filter((t) => t !== "integer");
        narrowed = narrowed.filter((t) => t !== "number");
      }
      for (const t of widened) add(p, `type now also allows ${t}`, onLoosen(direction));
      for (const t of narrowed) add(p, `type no longer allows ${t}`, onTighten(direction));
    } else if (ot.length && !nt.length && n.const === undefined && !n.anyOf && !n.oneOf) {
      add(p, "type constraint removed", onLoosen(direction));
    } else if (!ot.length && nt.length && o.const === undefined && !o.anyOf && !o.oneOf) {
      add(p, `type constraint added (${nt.join("|")})`, onTighten(direction));
    }

    // ---- const / enum
    if (o.const !== undefined || n.const !== undefined) {
      if (JSON.stringify(o.const) !== JSON.stringify(n.const)) add(p, `const ${JSON.stringify(o.const)} → ${JSON.stringify(n.const)}`, "breaking");
    }
    if (o.enum || n.enum) {
      const oe = o.enum ?? null;
      const ne = n.enum ?? null;
      if (oe && !ne) add(p, "enum restriction removed", onLoosen(direction));
      else if (!oe && ne) add(p, "enum restriction added", onTighten(direction));
      else {
        const added = ne.filter((v) => !oe.some((x) => JSON.stringify(x) === JSON.stringify(v)));
        const removed = oe.filter((v) => !ne.some((x) => JSON.stringify(x) === JSON.stringify(v)));
        // A new value is "warning" for readers: tolerant consumers ignore it, switch statements may not.
        if (added.length) add(p, `enum values added: ${added.join(", ")}`, direction === "read" ? "warning" : "safe");
        if (removed.length) add(p, `enum values removed: ${removed.join(", ")}`, onTighten(direction));
      }
    }

    // ---- string / number constraints
    for (const key of ["format", "pattern"]) {
      if (o[key] === n[key]) continue;
      if (o[key] === undefined) add(p, `${key} added: ${n[key]}`, onTighten(direction));
      else if (n[key] === undefined) add(p, `${key} removed (was ${o[key]})`, direction === "read" ? "warning" : "safe");
      else add(p, `${key} changed: ${o[key]} → ${n[key]}`, direction === "write" ? "breaking" : "warning");
    }
    const bounds = [
      ["minimum", 1], ["exclusiveMinimum", 1], ["minLength", 1], ["minItems", 1], ["minProperties", 1],
      ["maximum", -1], ["exclusiveMaximum", -1], ["maxLength", -1], ["maxItems", -1], ["maxProperties", -1],
    ];
    for (const [key, sign] of bounds) {
      if (o[key] === n[key]) continue;
      // sign 1: a bigger minimum tightens; sign -1: a smaller maximum tightens.
      const tightened = o[key] === undefined || (n[key] !== undefined && (n[key] - o[key]) * sign > 0);
      add(p, `${key} ${o[key] ?? "none"} → ${n[key] ?? "none"}`, tightened ? onTighten(direction) : direction === "read" ? "warning" : "safe");
    }

    // ---- objects
    if (o.properties || n.properties || o.required || n.required) {
      const op = o.properties ?? {};
      const np = n.properties ?? {};
      const oreq = new Set(o.required ?? []);
      const nreq = new Set(n.required ?? []);
      for (const k of Object.keys(op)) {
        const kp = `${p}.${k}`;
        if (!(k in np)) {
          // Readers may use any field; strict owners reject a field writers still send.
          if (direction === "read") add(kp, "property removed", "breaking");
          else add(kp, "property removed", n.additionalProperties === false ? "breaking" : "safe");
          continue;
        }
        if (oreq.has(k) && !nreq.has(k)) add(kp, "no longer required (may be missing)", onLoosen(direction));
        if (!oreq.has(k) && nreq.has(k)) add(kp, "now required", onTighten(direction));
        walk(op[k], np[k], kp);
      }
      for (const k of Object.keys(np)) {
        if (k in op) continue;
        const kp = `${p}.${k}`;
        if (nreq.has(k) && direction === "write") add(kp, "new REQUIRED property", "breaking");
        else add(kp, nreq.has(k) ? "new required property" : "new optional property", "safe");
      }
    }
    if (o.additionalProperties !== false && n.additionalProperties === false) add(p, "additional properties now rejected", onTighten(direction));

    // ---- arrays
    if (o.items || n.items) walk(o.items ?? {}, n.items ?? {}, `${p}[]`);

    // ---- unions we do not analyse in depth
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if ((o[key] || n[key]) && JSON.stringify(o[key]) !== JSON.stringify(n[key])) {
        const os = o[key] ?? [];
        const ns = n[key] ?? [];
        if (os.length === ns.length) os.forEach((sub, i) => walk(sub, ns[i], `${p}<${key}${i}>`));
        else add(p, `${key} changed (${os.length} → ${ns.length} alternatives): review by hand`, "warning");
      }
    }
  }
}

// --------------------------------------------------------------------------------- messages
/** Compares two catalogs (lib/catalog.mjs). */
export function compareCatalogs(base, head) {
  const findings = [];
  const key = (m) => `${m.name} v${m.version}`;
  const baseByKey = new Map(base.messages.map((m) => [key(m), m]));
  const headByKey = new Map(head.messages.map((m) => [key(m), m]));

  for (const [k, m] of baseByKey) {
    if (!headByKey.has(k)) findings.push({ contract: k, path: "(message)", change: `removed (${m.kind} owned by ${m.owner})`, severity: "breaking" });
  }
  for (const [k, n] of headByKey) {
    const m = baseByKey.get(k);
    if (!m) {
      findings.push({ contract: k, path: "(message)", change: `added (${n.kind} owned by ${n.owner})`, severity: "safe" });
      continue;
    }
    const direction = m.kind === "command" ? "write" : "read";
    if (m.kind !== n.kind) findings.push({ contract: k, path: "(message)", change: `kind ${m.kind} → ${n.kind}`, severity: "breaking" });
    if (m.channel !== n.channel) findings.push({ contract: k, path: "(message)", change: `channel ${m.channel} → ${n.channel}`, severity: "breaking" });
    const strip = ({ $ref: _r, $id: _i, title: _t, description: _d, ...rest }) => rest;
    for (const f of compareSchemas(strip(m.schema), strip(n.schema), { direction })) findings.push({ contract: k, ...f });
    const gone = m.consumers.filter((c) => !n.consumers.includes(c));
    const added = n.consumers.filter((c) => !m.consumers.includes(c));
    if (gone.length || added.length) findings.push({ contract: k, path: "(message)", change: `consumers ${added.length ? `+${added.join(",")} ` : ""}${gone.length ? `-${gone.join(",")}` : ""}`.trim(), severity: "safe" });
  }

  // The envelope is read AND written by everyone: any change in either direction counts.
  for (const direction of ["read", "write"]) {
    for (const f of compareSchemas(base.envelope, head.envelope, { direction })) {
      if (f.severity !== "safe") findings.push({ contract: "envelope v1", ...f, change: `${f.change} (${direction === "read" ? "consumers" : "producers"} affected)` });
    }
  }
  return findings;
}

// --------------------------------------------------------------------------------- OpenAPI
const METHODS = ["get", "post", "put", "patch", "delete"];

function operations(doc) {
  const ops = new Map();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) {
      // /orders/{orderId} and /orders/{id} are the same operation.
      if (item[m]) ops.set(`${m.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`, { op: item[m], shared: item.parameters ?? [], path });
    }
  }
  return ops;
}

const resolver = (doc) => (ref) => {
  if (!ref.startsWith("#/")) throw new Error(`external $ref not supported: ${ref}`);
  return ref.slice(2).split("/").reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc) ?? {};
};

function jsonSchemaOf(content) {
  const c = content ?? {};
  const key = Object.keys(c).find((k) => k.includes("json")) ?? Object.keys(c)[0];
  return key ? c[key].schema : undefined;
}

/** Compares two OpenAPI documents of ONE service. */
export function compareOpenApi(service, base, head) {
  const findings = [];
  const resolveOld = resolver(base);
  const resolveNew = resolver(head);
  const deref = (x, resolve) => (x?.$ref ? resolve(x.$ref) : x);
  const bOps = operations(base);
  const hOps = operations(head);

  for (const [k] of bOps) if (!hOps.has(k)) findings.push({ contract: service, path: k, change: "operation removed", severity: "breaking" });
  for (const [k] of hOps) if (!bOps.has(k)) findings.push({ contract: service, path: k, change: "operation added", severity: "safe" });

  for (const [k, b] of bOps) {
    const h = hOps.get(k);
    if (!h) continue;
    const at = (where) => `${k} ${where}`;

    // ---- parameters (the CLIENT writes them)
    const params = (x, resolve) =>
      new Map([...x.shared, ...(x.op.parameters ?? [])].map((p) => deref(p, resolve)).filter((p) => p.in !== "header" || !["authorization"].includes(p.name.toLowerCase())).map((p) => [`${p.in}:${p.name}`, p]));
    const bp = params(b, resolveOld);
    const hp = params(h, resolveNew);
    for (const [name, p] of bp) {
      const q = hp.get(name);
      if (!q) {
        findings.push({ contract: service, path: at(name), change: "parameter removed", severity: p.in === "path" ? "breaking" : "warning" });
        continue;
      }
      if (!p.required && q.required) findings.push({ contract: service, path: at(name), change: "parameter now required", severity: "breaking" });
      for (const f of compareSchemas(p.schema ?? {}, q.schema ?? {}, { direction: "write", path: name, resolveOld, resolveNew })) findings.push({ contract: service, ...f, path: at(f.path) });
    }
    for (const [name, q] of hp) {
      if (!bp.has(name)) findings.push({ contract: service, path: at(name), change: q.required ? "new REQUIRED parameter" : "new optional parameter", severity: q.required ? "breaking" : "safe" });
    }

    // ---- request body (the CLIENT writes it)
    const bBody = deref(b.op.requestBody, resolveOld);
    const hBody = deref(h.op.requestBody, resolveNew);
    if (!bBody?.required && hBody?.required) findings.push({ contract: service, path: at("body"), change: "request body now required", severity: "breaking" });
    if (jsonSchemaOf(bBody?.content) || jsonSchemaOf(hBody?.content)) {
      for (const f of compareSchemas(jsonSchemaOf(bBody?.content) ?? {}, jsonSchemaOf(hBody?.content) ?? {}, { direction: "write", path: "body", resolveOld, resolveNew })) {
        findings.push({ contract: service, ...f, path: at(f.path) });
      }
    }

    // ---- success responses (the SERVER writes them)
    for (const [status, resp] of Object.entries(b.op.responses ?? {})) {
      if (!/^2/.test(status)) continue;
      const next = h.op.responses?.[status];
      if (!next) {
        findings.push({ contract: service, path: at(status), change: "success response removed", severity: "breaking" });
        continue;
      }
      const os = jsonSchemaOf(deref(resp, resolveOld)?.content);
      const ns = jsonSchemaOf(deref(next, resolveNew)?.content);
      if (os || ns) for (const f of compareSchemas(os ?? {}, ns ?? {}, { direction: "read", path: status, resolveOld, resolveNew })) findings.push({ contract: service, ...f, path: at(f.path) });
    }
  }
  return findings;
}

// --------------------------------------------------------------------------------- versioning
/** The smallest semantic-version bump these findings require. */
export function requiredBump(findings) {
  if (findings.some((f) => f.severity === "breaking")) return "major";
  if (findings.some((f) => /added|new /.test(f.change))) return "minor";
  return findings.length ? "patch" : "none";
}

export function bumpOf(from, to) {
  const [a, b, c] = from.split(".").map(Number);
  const [x, y, z] = to.split(".").map(Number);
  if (x > a) return "major";
  if (x === a && y > b) return "minor";
  if (x === a && y === b && z > c) return "patch";
  return "none";
}

export const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };
