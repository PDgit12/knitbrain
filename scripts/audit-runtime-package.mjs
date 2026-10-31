import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Checks an ACTUAL tarball; source allowlists alone do not prove package contents.
const [tarball, unpacked] = process.argv.slice(2);
assert(tarball && unpacked, 'usage: node scripts/audit-runtime-package.mjs <actual.tgz> <unpacked package directory>');
const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
assert.equal(listed.status, 0, listed.stderr);
const files = listed.stdout.trim().split('\n').filter((file) => !file.endsWith('/'));
for (const file of files) {
  assert(file.startsWith('package/') && !file.split('/').includes('..'), `unsafe archive path: ${file}`);
  const relative = file.slice('package/'.length);
  assert(relative.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(relative), `unexpected packaged content: ${file}`);
  assert(!/(^|\/)(tests?|__tests__|fixtures?|__mocks__|mocks|scripts|coverage|node_modules)(\/|$)/i.test(relative), `test/mock content in runtime package: ${file}`);
  assert(!/(^|\/)\.env(?:\.|$)|\.(?:test|spec)\.[cm]?[jt]s(?:\.|$)|\.jsonl$|\.tgz$/i.test(relative), `private/test artifact in runtime package: ${file}`);
}
const metadata = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'));
for (const entry of [metadata.main, ...Object.values(metadata.bin)]) assert(files.includes(`package/${entry}`), `missing runtime entrypoint: ${entry}`);
let jsFiles = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!name.endsWith('.js')) continue;
    jsFiles++;
    const code = readFileSync(path, 'utf8');
    assert(!/(?:from\s*|import\s*\(|require\s*\()\s*['"][^'"]*(?:\/(?:tests?|fixtures?|__mocks__|mocks)\/|\.(?:test|spec)\.)/i.test(code), `runtime imports test/mock content: ${path}`);
  }
}
walk(join(unpacked, 'dist'));
console.log(JSON.stringify({ result: 'PASS', sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'), packageFiles: files.length, javascriptFiles: jsFiles, claim: 'No packaged test/mock fixture paths, transcript files, secrets filenames or test/mock imports found. Static package inspection does not prove live-host behavior or arbitrary runtime data provenance.' }, null, 2));
