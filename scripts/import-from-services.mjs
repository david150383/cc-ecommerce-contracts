// ONE-TIME import (Phase 6): copies every message schema + example and every OpenAPI document out of
// the sibling service repositories. Afterwards message schemas are authored HERE (contract-first) and
// OpenAPI documents are re-published from the services with `npm run sync:openapi` (code-first).
//
//   node scripts/import-from-services.mjs [--root ..]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICES } from "../lib/services.mjs";

const root = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : "..";
const here = new URL("..", import.meta.url).pathname;
const write = (path, obj) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
};

let envelope;
for (const svc of SERVICES) {
  const repo = join(root, svc.repo);
  const schemasDir = join(repo, "events", "schemas");
  if (existsSync(schemasDir)) {
    for (const file of readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"))) {
      const schema = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
      if (file.startsWith("envelope.")) {
        // Six hand-kept copies, identical except $id: keep ONE, under common/.
        const { $id, ...rest } = schema;
        envelope ??= { $id: "https://schemas.ecommerce.local/common/envelope.v1.schema.json", ...rest };
        continue;
      }
      schema.$ref = "../common/envelope.v1.schema.json";
      if (typeof schema["x-producer"] === "string" && schema["x-producer"].includes(","))
        schema["x-producer"] = schema["x-producer"].split(",").map((s) => s.trim());
      write(join(here, "schemas", svc.name, file), schema);
      const example = join(repo, "events", "examples", file.replace(".schema.json", ".json"));
      if (existsSync(example)) cpSync(example, join(here, "examples", svc.name, file.replace(".schema.json", ".json")));
    }
  }
  const openapi = join(repo, "openapi", "openapi.json");
  if (existsSync(openapi)) write(join(here, "openapi", `${svc.name}.openapi.json`), JSON.parse(readFileSync(openapi, "utf8")));
  else console.warn(`no openapi/openapi.json in ${svc.repo}`);
}
write(join(here, "schemas", "common", "envelope.v1.schema.json"), envelope);
console.log("imported");
