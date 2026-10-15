import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SERVICES } from "./services.mjs";

export const ROOT = new URL("..", import.meta.url).pathname;
const VOCABULARY = ["x-producer", "x-consumers", "x-channel", "x-message-kind"];

/** "ecommerce-order-service" → "order-service". */
const short = (name) => name.replace(/^ecommerce-/, "");
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(short);

/**
 * Every message contract, from the files on disk (or from `read`, e.g. a git revision).
 * The folder a schema lives in is its OWNER: the producer for events, the consumer for commands.
 */
export function loadCatalog(read = (rel) => readFileSync(join(ROOT, rel), "utf8"), listDir = (rel) => (existsSync(join(ROOT, rel)) ? readdirSync(join(ROOT, rel)) : [])) {
  const envelope = JSON.parse(read("schemas/common/envelope.v1.schema.json"));
  const messages = [];
  for (const owner of listDir("schemas").filter((d) => d !== "common").sort()) {
    for (const file of listDir(`schemas/${owner}`).filter((f) => f.endsWith(".schema.json")).sort()) {
      const path = `schemas/${owner}/${file}`;
      const schema = JSON.parse(read(path));
      const examplePath = `examples/${owner}/${file.replace(".schema.json", ".json")}`;
      let example = null;
      try {
        example = JSON.parse(read(examplePath));
      } catch {
        // missing example: reported by the tests
      }
      messages.push({
        name: schema.properties?.messageType?.const,
        version: schema.properties?.messageVersion?.const,
        kind: schema["x-message-kind"],
        owner,
        producers: list(schema["x-producer"]),
        consumers: list(schema["x-consumers"]),
        channel: schema["x-channel"], // "SNS order-events" | "SQS inventory-commands"
        path,
        examplePath,
        schema,
        example,
      });
    }
  }
  return { envelope, messages };
}

/** One Ajv instance with every schema registered (message $refs resolve to the shared envelope by $id). */
export function compile(catalog) {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addVocabulary(VOCABULARY);
  ajv.addSchema(catalog.envelope);
  for (const m of catalog.messages) ajv.addSchema(m.schema);
  return ajv;
}

export function loadOpenApi(read = (rel) => readFileSync(join(ROOT, rel), "utf8")) {
  const out = {};
  for (const svc of SERVICES) {
    try {
      out[svc.name] = JSON.parse(read(`openapi/${svc.name}.openapi.json`));
    } catch {
      // not present at this revision
    }
  }
  return out;
}
