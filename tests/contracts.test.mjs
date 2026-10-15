import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import specs from "@asyncapi/specs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { compile, loadCatalog, loadOpenApi, ROOT } from "../lib/catalog.mjs";
import { SERVICES } from "../lib/services.mjs";

const catalog = loadCatalog();
const ajv = compile(catalog);
const kebab = (name) => name.replace(/(?<!^)([A-Z])/g, "-$1").toLowerCase();
const service = Object.fromEntries(SERVICES.map((s) => [s.name, s]));

describe("message schemas", () => {
  it("there is ONE envelope, and every message builds on it", () => {
    const envelopes = catalog.messages.filter((m) => m.path.includes("envelope"));
    expect(envelopes).toEqual([]);
    for (const m of catalog.messages) expect(m.schema.$ref, m.path).toBe("../common/envelope.v1.schema.json");
  });

  it.each(catalog.messages.map((m) => [m.path, m]))("%s: compiles, its example validates, a broken envelope does not", (_p, m) => {
    const validate = ajv.getSchema(m.schema.$id);
    expect(validate).toBeDefined();
    expect(m.example, `missing ${m.examplePath}`).not.toBeNull();
    validate(m.example);
    expect(validate.errors ?? []).toEqual([]);
    const { messageId: _drop, ...noId } = m.example;
    expect(validate(noId)).toBe(false);
  });

  it.each(catalog.messages.map((m) => [m.path, m]))("%s: name, version, $id and file agree", (_p, m) => {
    expect(m.name).toMatch(/^[A-Z][A-Za-z]+$/);
    expect(Number.isInteger(m.version) && m.version >= 1).toBe(true);
    const file = `${kebab(m.name)}.v${m.version}.schema.json`;
    expect(m.path).toBe(`schemas/${m.owner}/${file}`);
    expect(m.schema.$id).toBe(`https://schemas.ecommerce.local/${m.owner}/${file}`);
    expect(m.example?.messageType).toBe(m.name);
  });

  it.each(catalog.messages.map((m) => [m.path, m]))("%s: owner, kind and channel follow the ownership rules", (_p, m) => {
    expect(["event", "command"]).toContain(m.kind);
    if (m.kind === "event") {
      // Events: owned by their (single) producer, published on the owner's topic.
      expect(m.producers).toEqual([m.owner]);
      expect(m.channel).toBe(`SNS ${service[m.owner].topic}`);
    } else {
      // Commands: owned by their (single) consumer, sent to the owner's command queue.
      expect(m.consumers).toEqual([m.owner]);
      expect(m.channel).toBe(`SQS ${service[m.owner].commandQueue}`);
    }
    for (const s of [...m.producers, ...m.consumers]) expect(Object.keys(service), `${s} is not a known service`).toContain(s);
  });

  it("every (message, version) is unique", () => {
    const keys = catalog.messages.map((m) => `${m.name}@${m.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("OpenAPI documents", () => {
  it("one per service, each a valid-looking OpenAPI 3.x document", () => {
    const docs = loadOpenApi();
    expect(Object.keys(docs).sort()).toEqual(SERVICES.map((s) => s.name).sort());
    for (const [name, doc] of Object.entries(docs)) {
      expect(doc.openapi, name).toMatch(/^3\.(0|1)\./);
      expect(Object.keys(doc.paths ?? {}).length, name).toBeGreaterThan(0);
    }
  });
});

describe("generated artifacts", () => {
  it("asyncapi.json and OWNERSHIP.md are up to date (npm run build)", () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs"), "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("the AsyncAPI document is valid AsyncAPI 3.0.0 and every payload file exists", () => {
    const doc = JSON.parse(readFileSync(join(ROOT, "asyncapi", "asyncapi.json"), "utf8"));
    // The AsyncAPI spec bundles its own draft-07 meta-schema: skip Ajv's built-in one to avoid a duplicate $id.
    const v = new Ajv({ strict: false, allErrors: true, meta: false, validateSchema: false });
    addFormats.default(v);
    const validate = v.compile(specs.schemas["3.0.0"]);
    validate(doc);
    expect(validate.errors ?? []).toEqual([]);
    for (const msg of Object.values(doc.components.messages)) expect(existsSync(join(ROOT, "asyncapi", msg.payload.schema.$ref))).toBe(true);
    expect(Object.keys(doc.components.messages)).toHaveLength(catalog.messages.length);
  });

  it("no stray files: every example has a schema", () => {
    for (const owner of readdirSync(join(ROOT, "examples"))) {
      for (const f of readdirSync(join(ROOT, "examples", owner))) expect(existsSync(join(ROOT, "schemas", owner, f.replace(".json", ".schema.json"))), f).toBe(true);
    }
  });
});
