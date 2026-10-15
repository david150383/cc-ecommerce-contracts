// Is this change backward compatible, and is the version bump big enough?
//
//   node scripts/compat.mjs                 compare the working tree with the latest release tag
//   node scripts/compat.mjs --base v1.0.0   ... with a given ref
//
// Exit 1 when: a change is breaking and the version does not bump MAJOR, or the bump is smaller than
// the changes need (additions need MINOR). Breaking changes are not forbidden; they must be deliberate
// (a new major, and per VERSIONING.md normally a new message version or /api/v2 next to the old one).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, loadOpenApi, ROOT } from "../lib/catalog.mjs";
import { BUMP_RANK, bumpOf, compareCatalogs, compareOpenApi, requiredBump, worst } from "../lib/compat.mjs";

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);

let base = arg("--base");
if (!base) {
  try {
    base = git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    console.log("No release tag yet: nothing to compare with (the first release defines the baseline).");
    process.exit(0);
  }
}

const readAt = (rel) => git("show", `${base}:${rel}`);
const listAt = (rel) => {
  try {
    return git("ls-tree", "--name-only", `${base}:${rel}`).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const findings = [
  ...compareCatalogs(loadCatalog(readAt, listAt), loadCatalog()),
  ...(() => {
    const before = loadOpenApi(readAt);
    const after = loadOpenApi();
    const out = [];
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!after[name]) out.push({ contract: name, path: "(api)", change: "OpenAPI document removed", severity: "breaking" });
      else if (!before[name]) out.push({ contract: name, path: "(api)", change: "OpenAPI document added", severity: "safe" });
      else out.push(...compareOpenApi(name, before[name], after[name]));
    }
    return out;
  })(),
];

const ICON = { breaking: "✗ BREAKING", warning: "! warning ", safe: "· safe    " };
const order = { breaking: 0, warning: 1, safe: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.contract.localeCompare(b.contract));
console.log(`Compared with ${base}: ${findings.length} change(s)`);
for (const f of findings) console.log(`  ${ICON[f.severity]}  ${f.contract}  ${f.path}: ${f.change}`);

const baseVersion = JSON.parse(readAt("package.json")).version;
const headVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const needed = requiredBump(findings);
const made = bumpOf(baseVersion, headVersion);
console.log(`\nVersion ${baseVersion} → ${headVersion} (${made}); these changes need at least: ${needed}.`);

if (BUMP_RANK[made] < BUMP_RANK[needed]) {
  console.error(
    worst(findings) === "breaking"
      ? "✗ Breaking change without a major version. Prefer a NEW version of the message (v2 next to v1) or /api/v2; see VERSIONING.md."
      : `✗ Bump the version in package.json (at least ${needed}).`,
  );
  process.exit(1);
}
if (worst(findings) === "warning") console.log("! Warnings: review them; they can break consumers that are not tolerant readers.");
console.log("✓ OK");
