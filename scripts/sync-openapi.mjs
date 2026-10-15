// Re-publishes the OpenAPI documents the services generate from their code (code-first APIs).
//   node scripts/sync-openapi.mjs [--root ..]
// Then `npm run compat` tells whether the change is compatible and which version bump it needs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/catalog.mjs";
import { SERVICES } from "../lib/services.mjs";

const root = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : join(ROOT, "..");
for (const s of SERVICES) {
  const doc = JSON.parse(readFileSync(join(root, s.repo, "openapi", "openapi.json"), "utf8"));
  const out = join(ROOT, "openapi", `${s.name}.openapi.json`);
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  let prev = "";
  try {
    prev = readFileSync(out, "utf8");
  } catch {
    // new
  }
  if (prev !== next) {
    writeFileSync(out, next);
    console.log(`updated openapi/${s.name}.openapi.json`);
  }
}
