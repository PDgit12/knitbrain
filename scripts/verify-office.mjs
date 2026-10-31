import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const office = read('docs/office/office.json');
const backlog = read('docs/office/backlog.json');
const findings = read('docs/audits/2026-10-22/findings.json').findings;
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
assert.equal(office.schemaVersion, 1);
assert.equal(backlog.schemaVersion, 1);
assert(nonblank(office.parent.goal) && nonblank(office.parent.integrationGate));
assert(Number.isInteger(office.capacity.maxActiveSubagents) && office.capacity.maxActiveSubagents > 0);
const teams = new Map();
const agents = new Set();
const files = new Set();
for (const team of office.teams) {
  assert(nonblank(team.id) && !teams.has(team.id), 'unique team IDs required');
  assert(nonblank(team.agent) && !agents.has(team.agent), 'unique initialized lead identities required');
  assert(nonblank(team.goal) && nonblank(team.verifyCommand), `${team.id}: goal and gate required`);
  assert.equal(team.planningStatus, 'complete', `${team.id}: charter pending`);
  assert(nonblank(team.boardPost), `${team.id}: peer agreement reference missing`);
  assert(Number.isInteger(team.workers) && team.workers > 0, `${team.id}: worker count invalid`);
  assert(team.ownedFiles.length > 0, `${team.id}: ownership missing`);
  for (const file of team.ownedFiles) {
    assert(!files.has(file), `overlapping write ownership: ${file}`);
    assert(existsSync(resolve(root, file)), `declared foundation file missing: ${file}`);
    files.add(file);
  }
  agents.add(team.agent);
  teams.set(team.id, team);
}
assert(teams.size > 0);
assert.equal(office.capacity.overflow, 'queue-fairly');
for (const team of office.teams) {
  for (const peer of team.peers) {
    assert(teams.has(peer) && peer !== team.id, `invalid peer ${peer}`);
    assert(teams.get(peer).peers.includes(team.id), `one-sided collaboration: ${team.id}/${peer}`);
  }
}
const checkDag = (items) => {
  const map = new Map(items.map((item) => [item.id, item]));
  assert.equal(map.size, items.length, 'duplicate work IDs');
  const visiting = new Set();
  const done = new Set();
  function visit(id) {
    assert(map.has(id), `missing dependency: ${id}`);
    assert(!visiting.has(id), `dependency cycle: ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of map.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    done.add(id);
  }
  for (const id of map.keys()) visit(id);
};
const validOwner = (owner) => owner === office.parent.agent || teams.has(owner);
for (const work of office.workOrder) assert(validOwner(work.owner) && nonblank(work.goal));
checkDag(office.workOrder);
checkDag(backlog.items);
assert.equal(backlog.items.length, findings.length, 'every audit finding must have an owner');
for (const finding of findings) {
  const item = backlog.items.find((entry) => entry.id === finding.id);
  assert(item && validOwner(item.owner), `unassigned finding: ${finding.id}`);
  assert.equal(item.sourceStatus, finding.status, `${finding.id}: stale status`);
  assert.equal(item.acceptance, finding.acceptance, `${finding.id}: altered acceptance`);
  assert.deepEqual(item.dependsOn, finding.dependsOn, `${finding.id}: altered dependencies`);
}
assert.deepEqual(office.sharedContract.identity, ['runId', 'taskId', 'domainId', 'attempt']);
assert.equal(office.sharedContract.hooksAuthority, 'observations-only');
assert.equal(office.sharedContract.unconfirmedTermination, 'quarantine-no-retry-no-reuse');
assert.equal(office.sharedContract.peerAgreement, 'confirmed-by-all-three-leads');
console.log(`[office] PASS: ${teams.size} domain charters, disjoint file ownership, reciprocal peers, acyclic work dependencies, ${backlog.items.length} audit assignments.`);
console.log(`[office] Artifact consistency only. Runtime launched: ${office.runtime.launched}; implementation paused: ${office.runtime.implementationPaused}. Agent execution and product acceptance require separate evidence.`);
