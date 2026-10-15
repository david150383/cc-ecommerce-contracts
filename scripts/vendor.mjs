// Pins a service to a contracts RELEASE: copies the files it needs, as they are at the tag, into the
// service repository and records them in contracts.lock.json.
//
//   node scripts/vendor.mjs --service order-service --into ../ecommerce-order-service --version v1.0.0
//   node scripts/vendor.mjs --service frontend --into ../ecommerce-frontend --version v1.0.0
//
// Messages: everything the service OWNS, SENDS or RECEIVES, plus the envelope, into events/schemas and
// events/examples (where the services already load them from). The frontend gets the OpenAPI documents.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, ROOT } from "../lib/catalog.mjs";
import { SERVICES } from "../lib/services.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`);
  return process.argv[i + 1];
};
const service = arg("--service");
const into = arg("--into");
const version = arg("--version");

const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = git("rev-list", "-n", "1", version).trim(); // a tag, never the working tree
const readAt = (rel) => git("show", `${commit}:${rel}`);
const listAt = (rel) => git("ls-tree", "--name-only", `${commit}:${rel}`).split("\n").filter(Boolean);

/** target path in the service repo → content */
const files = new Map();
let directories;
if (service === "frontend") {
  directories = ["contracts/openapi"];
  for (const s of SERVICES) files.set(`contracts/openapi/${s.name}.openapi.json`, readAt(`openapi/${s.name}.openapi.json`));
} else {
  if (!SERVICES.some((s) => s.name === service)) throw new Error(`unknown service ${service}`);
  directories = ["events/schemas", "events/examples"];
  const catalog = loadCatalog(readAt, listAt);
  files.set("events/schemas/envelope.v1.schema.json", readAt("schemas/common/envelope.v1.schema.json"));
  for (const m of catalog.messages) {
    if (m.owner !== service && !m.producers.includes(service) && !m.consumers.includes(service)) continue;
    const name = m.path.split("/").pop();
    files.set(`events/schemas/${name}`, readAt(m.path));
    files.set(`events/examples/${name.replace(".schema.json", ".json")}`, readAt(m.examplePath));
  }
}

// Replace the vendored directories entirely: a message the service no longer uses disappears.
for (const dir of directories) rmSync(join(into, dir), { recursive: true, force: true });
const lockFiles = {};
for (const [rel, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  mkdirSync(join(into, rel, ".."), { recursive: true });
  writeFileSync(join(into, rel), content);
  lockFiles[rel] = createHash("sha256").update(content).digest("hex");
}
mkdirSync(join(into, "scripts"), { recursive: true });
writeFileSync(join(into, "scripts", "verify-contracts.mjs"), readFileSync(join(ROOT, "templates", "verify-contracts.mjs")));
writeFileSync(
  join(into, "contracts.lock.json"),
  `${JSON.stringify({ source: "ecommerce-contracts", version, commit, service, directories, files: lockFiles }, null, 2)}\n`,
);
console.log(`${service}: ${files.size} files from ecommerce-contracts@${version} (${commit.slice(0, 12)}) → ${into}`);
for (const dir of directories) console.log(`  ${dir}: ${readdirSync(join(into, dir)).length} files`);
