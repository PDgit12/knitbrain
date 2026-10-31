import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const checkout = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'knitbrain-package-audit-'));
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: checkout, encoding: 'utf8', timeout: 120_000, ...options });
  assert.equal(result.status, 0, `${executable} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
const metadata = JSON.parse(command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { shell: process.platform === 'win32' }));
const archive = join(directory, metadata[0].filename);
const extracted = join(directory, 'extracted'); mkdirSync(extracted);
command('tar', ['-xzf', archive, '-C', extracted]);
const artifact = join(extracted, 'package');
const inspection = JSON.parse(command(process.execPath, ['scripts/audit-runtime-package.mjs', archive, artifact]));
// Smoke the actual packed code with the checkout's already-installed lockfile deps.
// This is not a clean-install or live-client acceptance claim.
symlinkSync(resolve(checkout, 'node_modules'), join(artifact, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const doctor = JSON.parse(command(process.execPath, [join(artifact, 'dist/index.js'), 'doctor'], { cwd: extracted }));
assert.equal(doctor.connection.verified, false);
assert.equal(doctor.runtime.sourceTreePresent, false);
const packageJson = JSON.parse(readFileSync(join(artifact, 'package.json'), 'utf8'));
console.log(JSON.stringify({ ...inspection, version: packageJson.version, artifact: archive, packedDoctorSmoke: 'PASS with existing lockfile dependencies', liveConnectionVerified: false }, null, 2));
