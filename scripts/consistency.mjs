/**
 * Consistency gate — kills the staleness problem structurally.
 * Derives the truth from the CODE and fails the build when any doc/script
 * hardcodes a drifted number. Runs as part of `npm run verify` (after build).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
};

// Source of truth: the built code.
const { TOOLS } = await import(pathToFileURL(join(ROOT, "dist/mcp/tools.js")).href);
const { VERSION } = await import(pathToFileURL(join(ROOT, "dist/version.js")).href);
const toolCount = TOOLS.length;

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const audit = readFileSync(join(ROOT, "scripts/production-audit.mjs"), "utf8");

console.log(`[consistency] truth from code: ${toolCount} tools · v${VERSION}`);

ok(pkg.version === VERSION, `package.json version (${pkg.version}) === src/version.ts (${VERSION})`);

// Every "N tools" mention in README must equal the real count.
const readmeCounts = [...readme.matchAll(/(\d+)\s+tools/g)].map((m) => Number(m[1]));
ok(
  readmeCounts.length > 0 && readmeCounts.every((n) => n === toolCount),
  `README tool mentions [${readmeCounts.join(", ")}] all equal ${toolCount}`,
);

// The production audit must not assert a stale hardcoded count.
const auditCounts = [...audit.matchAll(/names\.length === (\d+)/g)].map((m) => Number(m[1]));
ok(
  auditCounts.every((n) => n === toolCount),
  `production-audit asserted counts [${auditCounts.join(", ")}] equal ${toolCount}`,
);

// Bins declared must exist in dist after build.
for (const [name, rel] of Object.entries(pkg.bin)) {
  let exists = true;
  try {
    readFileSync(join(ROOT, rel));
  } catch {
    exists = false;
  }
  ok(exists, `bin "${name}" → ${rel} exists in dist`);
}

console.log(failures === 0 ? "[consistency] PASS" : `[consistency] FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
