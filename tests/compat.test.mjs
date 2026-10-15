import { describe, expect, it } from "vitest";
import { bumpOf, compareCatalogs, compareOpenApi, compareSchemas, requiredBump, worst } from "../lib/compat.mjs";
import { loadCatalog } from "../lib/catalog.mjs";

const obj = (properties, required = Object.keys(properties), extra = {}) => ({ type: "object", required, additionalProperties: false, properties, ...extra });
const str = { type: "string" };
const severity = (o, n, direction) => worst(compareSchemas(o, n, { direction }));

describe("schema rules", () => {
  // [description, old, new, severity for readers (events/responses), severity for writers (commands/requests)]
  const cases = [
    ["identical", obj({ a: str }), obj({ a: str }), "safe", "safe"],
    ["new optional property", obj({ a: str }), obj({ a: str, b: str }, ["a"]), "safe", "safe"],
    ["new required property", obj({ a: str }), obj({ a: str, b: str }), "safe", "breaking"],
    ["property removed", obj({ a: str, b: str }), obj({ a: str }), "breaking", "breaking"],
    ["required → optional", obj({ a: str }), obj({ a: str }, []), "breaking", "safe"],
    ["optional → required", obj({ a: str }, []), obj({ a: str }), "safe", "breaking"],
    ["string → string|null", obj({ a: str }), obj({ a: { type: ["string", "null"] } }), "breaking", "safe"],
    ["string|null → string", obj({ a: { type: ["string", "null"] } }), obj({ a: str }), "safe", "breaking"],
    ["integer → number", obj({ a: { type: "integer" } }), obj({ a: { type: "number" } }), "breaking", "safe"],
    ["enum value added", obj({ a: { enum: ["X"] } }), obj({ a: { enum: ["X", "Y"] } }), "warning", "safe"],
    ["enum value removed", obj({ a: { enum: ["X", "Y"] } }), obj({ a: { enum: ["X"] } }), "safe", "breaking"],
    ["const changed", obj({ a: { const: 1 } }), obj({ a: { const: 2 } }), "breaking", "breaking"],
    ["maxLength lowered", obj({ a: { ...str, maxLength: 10 } }), obj({ a: { ...str, maxLength: 5 } }), "safe", "breaking"],
    ["maxLength raised", obj({ a: { ...str, maxLength: 5 } }), obj({ a: { ...str, maxLength: 10 } }), "warning", "safe"],
    ["format added", obj({ a: str }), obj({ a: { ...str, format: "uuid" } }), "safe", "breaking"],
    ["pattern changed", obj({ a: { ...str, pattern: "^a" } }), obj({ a: { ...str, pattern: "^b" } }), "warning", "breaking"],
    ["nested field removed", obj({ total: obj({ amountMinor: { type: "integer" }, currency: str }) }), obj({ total: obj({ amountMinor: { type: "integer" } }) }), "breaking", "breaking"],
    ["array item type changed", obj({ xs: { type: "array", items: str } }), obj({ xs: { type: "array", items: { type: "integer" } } }), "breaking", "breaking"],
    ["OpenAPI 3.0 nullable == string|null", obj({ a: { ...str, nullable: true } }), obj({ a: { type: ["string", "null"] } }), "safe", "safe"],
    ["pydantic anyOf null == string|null", obj({ a: { anyOf: [str, { type: "null" }] } }), obj({ a: { type: ["string", "null"] } }), "safe", "safe"],
  ];
  it.each(cases)("%s → readers: %s / writers: %s", (_name, o, n, read, write) => {
    expect(severity(o, n, "read")).toBe(read);
    expect(severity(o, n, "write")).toBe(write);
  });

  it("reports WHERE and WHAT changed", () => {
    const f = compareSchemas(obj({ payload: obj({ total: str }) }), obj({ payload: obj({ grandTotal: str }) }), { direction: "read" });
    expect(f).toEqual(expect.arrayContaining([
      { path: ".payload.total", change: "property removed", severity: "breaking" },
      { path: ".payload.grandTotal", change: "new required property", severity: "safe" },
    ]));
  });
});

describe("message catalog", () => {
  const head = loadCatalog();
  const clone = () => JSON.parse(JSON.stringify(head));

  it("the current catalog compared with itself has no findings", () => {
    expect(compareCatalogs(head, head)).toEqual([]);
  });

  it("an event field removed is breaking; the same done as a v2 message next to v1 is not", () => {
    const broken = clone();
    const m = broken.messages.find((x) => x.name === "OrderConfirmed");
    delete m.schema.properties.payload.properties.total;
    m.schema.properties.payload.required = m.schema.properties.payload.required.filter((r) => r !== "total");
    expect(worst(compareCatalogs(head, broken))).toBe("breaking");

    const evolved = clone();
    const v1 = evolved.messages.find((x) => x.name === "OrderConfirmed");
    const v2 = JSON.parse(JSON.stringify(v1));
    v2.version = 2;
    delete v2.schema.properties.payload.properties.total;
    evolved.messages.push(v2);
    expect(worst(compareCatalogs(head, evolved))).toBe("safe");
    expect(requiredBump(compareCatalogs(head, evolved))).toBe("minor");
  });

  it("removing a message is breaking (retire v1 only in a major release)", () => {
    const fewer = clone();
    fewer.messages = fewer.messages.filter((x) => x.name !== "OrderCreated");
    expect(compareCatalogs(head, fewer)).toEqual([expect.objectContaining({ contract: "OrderCreated v1", severity: "breaking" })]);
  });

  it("a new required field in a COMMAND breaks its senders; in an EVENT it does not break readers", () => {
    const c = clone();
    const cmd = c.messages.find((x) => x.name === "RefundRequested");
    cmd.schema.properties.payload.properties.note = str;
    cmd.schema.properties.payload.required.push("note");
    const evt = c.messages.find((x) => x.name === "RefundSucceeded");
    evt.schema.properties.payload.properties.note = str;
    evt.schema.properties.payload.required.push("note");
    const f = compareCatalogs(head, c);
    expect(f.find((x) => x.contract === "RefundRequested v1").severity).toBe("breaking");
    expect(f.find((x) => x.contract === "RefundSucceeded v1").severity).toBe("safe");
  });

  it("any envelope change counts, for producers and consumers alike", () => {
    const c = clone();
    c.envelope.required = c.envelope.required.filter((r) => r !== "correlationId");
    expect(worst(compareCatalogs(head, c))).toBe("breaking");
  });
});

describe("OpenAPI", () => {
  const doc = (paths, schemas = {}) => ({ openapi: "3.1.0", paths, components: { schemas } });
  const op = (body, response) => ({
    post: {
      ...(body && { requestBody: { required: true, content: { "application/json": { schema: body } } } }),
      responses: { 200: { description: "ok", content: { "application/json": { schema: response } } } },
    },
  });

  it("removing an operation or a response field breaks clients; adding them does not", () => {
    const base = doc({ "/a/{id}": op(null, { $ref: "#/components/schemas/A" }) }, { A: obj({ x: str, y: str }) });
    const removedField = doc({ "/a/{other}": op(null, { $ref: "#/components/schemas/A" }) }, { A: obj({ x: str }) });
    expect(compareOpenApi("svc", base, removedField)).toEqual([expect.objectContaining({ path: "POST /a/{} 200.y", change: "property removed", severity: "breaking" })]);
    const addedOp = doc({ "/a/{id}": op(null, { $ref: "#/components/schemas/A" }), "/b": op(null, str) }, { A: obj({ x: str, y: str, z: str }, ["x", "y"]) });
    expect(worst(compareOpenApi("svc", base, addedOp))).toBe("safe");
    expect(worst(compareOpenApi("svc", base, doc({}, {})))).toBe("breaking");
  });

  it("recursive schemas terminate, and a change deep inside one is still found", () => {
    const tree = (extra = {}) => ({ type: "object", required: ["name"], properties: { name: str, children: { type: "array", items: { $ref: "#/components/schemas/Node" } }, ...extra } });
    const base = doc({ "/tree": op(null, { $ref: "#/components/schemas/Node" }) }, { Node: tree({ slug: str }) });
    const head = doc({ "/tree": op(null, { $ref: "#/components/schemas/Node" }) }, { Node: tree() });
    expect(compareOpenApi("svc", base, base)).toEqual([]);
    expect(compareOpenApi("svc", base, head)).toEqual([expect.objectContaining({ path: "POST /tree 200.slug", change: "property removed", severity: "breaking" })]);
  });

  it("a new required request field or parameter breaks clients", () => {
    const base = doc({ "/a": op(obj({ x: str }), str) });
    expect(worst(compareOpenApi("svc", base, doc({ "/a": op(obj({ x: str, y: str }), str) })))).toBe("breaking");
    const withParam = doc({ "/a": { post: { ...op(obj({ x: str }), str).post, parameters: [{ in: "query", name: "q", required: true, schema: str }] } } });
    expect(compareOpenApi("svc", base, withParam)).toEqual([expect.objectContaining({ change: "new REQUIRED parameter", severity: "breaking" })]);
  });
});

describe("versioning", () => {
  it("breaking needs a major, additions a minor", () => {
    expect(requiredBump([{ severity: "breaking", change: "x" }])).toBe("major");
    expect(requiredBump([{ severity: "safe", change: "operation added" }])).toBe("minor");
    expect(requiredBump([])).toBe("none");
    expect([bumpOf("1.2.3", "2.0.0"), bumpOf("1.2.3", "1.3.0"), bumpOf("1.2.3", "1.2.4"), bumpOf("1.2.3", "1.2.3")]).toEqual(["major", "minor", "patch", "none"]);
  });
});
