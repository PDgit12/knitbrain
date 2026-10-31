// Validate the repair map's traceability, not the product's unresolved defects.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../dist/mcp/tools.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'docs/audits/2026-10-22');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const manifest = readJson(resolve(dir, 'findings.json'));
const inventory = readJson(resolve(dir, 'tools.json'));
const probes = readJson(resolve(dir, 'probes.json'));
const verification = readJson(resolve(dir, 'verification.json'));
const readme = readFileSync(resolve(dir, 'README.md'), 'utf8');
const details = readFileSync(resolve(dir, 'FINDINGS.md'), 'utf8');
const findings = manifest.findings;
const ids = new Set(findings.map((f) => f.id));
assert.equal(ids.size, findings.length, 'duplicate finding ID');
assert.equal(findings.length, 32, 'review map size changes explicitly');
const priorities = new Set(['P0', 'P1', 'P2']);
const statuses = new Set(['open', 'partial_local', 'verified_local_only', 'needs_reproduction', 'needs_evaluation', 'needs_benchmark', 'mapped_this_change']);
for (const f of findings) {
  assert(priorities.has(f.priority), `${f.id}: invalid priority`);
  assert(statuses.has(f.status), `${f.id}: status must distinguish open from delivered`);
  for (const field of ['domain', 'owner', 'confidence', 'title', 'source', 'evidence', 'fix', 'acceptance']) {
    assert.equal(typeof f[field], 'string', `${f.id}: missing ${field}`);
    assert(f[field].trim().length > 0, `${f.id}: empty ${field}`);
  }
  assert(existsSync(resolve(root, f.source)), `${f.id}: missing source ${f.source}`);
  assert(details.includes(`## ${f.id} `), `${f.id}: missing readable detail`);
  for (const dep of f.dependsOn) assert(ids.has(dep), `${f.id}: unknown dependency ${dep}`);
  if (f.evidence.startsWith('probes.json#')) {
    assert(probes.observations.some((p) => p.id === f.id), `${f.id}: no reproduction observation`);
  }
}
const visiting = new Set();
const visited = new Set();
function visit(id) {
  assert(!visiting.has(id), `cyclic repair dependency: ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dep of findings.find((f) => f.id === id).dependsOn) visit(dep);
  visiting.delete(id);
  visited.add(id);
}
for (const id of ids) visit(id);
assert.deepEqual(inventory.tools.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort(), 'tool inventory must match built MCP');
assert.equal(inventory.tools.length, 37);
for (const entry of inventory.tools) {
  assert(entry.area && entry.acceptance && entry.findings.length, `unmapped tool: ${entry.name}`);
  for (const id of entry.findings) assert(ids.has(id), `unknown finding on ${entry.name}`);
}
for (const file of ['repository.json', 'runtime-dependencies.json', 'probes.json', 'verification.json', 'tools.json', 'FINDINGS.md']) {
  assert(readme.includes(file), `index must link ${file}`);
  assert(existsSync(resolve(dir, file)), `missing evidence ${file}`);
}
assert.equal(verification.productAcceptance, false, 'open defects must not be represented as product green');
assert(verification.commands.every((c) => typeof c.exitCode === 'number' && c.command), 'command evidence needs exit codes');
for (const file of ['CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/optimization_regression.yml']) {
  assert(existsSync(resolve(root, file)), `missing review artifact ${file}`);
}
console.log(`[audit-map] PASS: ${findings.length} traceable findings, acyclic dependencies, ${inventory.tools.length} mapped tools, ${probes.observations.length} diagnostic observations. Product defects remain OPEN.`);
