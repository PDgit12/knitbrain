// Diagnostic observations, NOT a product acceptance test. No production state.
// Build first: npm run build && node scripts/audit-probes.mjs [output.json]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createKnowledge } from '../dist/engine/knowledge.js';
import { createMeter } from '../dist/engine/meter.js';
import { createSkillsStore } from '../dist/engine/skills.js';
import { createMemory } from '../dist/engine/memory.js';
import { createCalibration } from '../dist/engine/calibration.js';
import { createFeedback } from '../dist/engine/feedback.js';
import { createFileCCRStore } from '../dist/ccr/store.js';
import { createTeamBoard } from '../dist/engine/teams.js';
import { classifyTask } from '../dist/engine/workflow.js';
import { TOOLS, dispatch, verifyClaim } from '../dist/mcp/tools.js';
import { compress } from '../dist/optimizer/router.js';
import { countTokens } from '../dist/tokenizer.js';
import { createOptimizer } from '../dist/lib.js';

const root = mkdtempSync(join(tmpdir(), 'knitbrain-audit-'));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalHome = process.env.KNITBRAIN_HOME;
const originalProject = process.env.KNITBRAIN_PROJECT_DIR;
process.env.KNITBRAIN_HOME = join(root, 'home');
process.env.KNITBRAIN_PROJECT_DIR = join(root, 'project');
mkdirSync(process.env.KNITBRAIN_PROJECT_DIR, { recursive: true });
const observations = [];
const observe = (id, observed, defectPresent) => observations.push({ id, defectPresent, observed });
const tool = (name) => TOOLS.find((t) => t.name === name);
const ctx = (name) => {
  const dir = join(root, name);
  const ccr = createFileCCRStore(join(dir, 'ccr'));
  return {
    ccr, memory: createMemory(join(dir, 'memory')),
    knowledge: createKnowledge(process.env.KNITBRAIN_PROJECT_DIR, join(dir, 'knowledge')),
    feedback: createFeedback(join(dir, 'feedback')),
    team: createTeamBoard(join(dir, 'team'), ccr),
    meter: createMeter(join(dir, 'meter')),
    skills: createSkillsStore(join(dir, 'skills')),
    calibration: createCalibration(join(dir, 'calibration')),
  };
};
let client;
try {
  const context = ctx('loop');
  const blank = JSON.parse(dispatch(tool('knitbrain_run_loop'), { goal: 'verify audit fixture', verify_cmd: '' }, context));
  observe('KB-001', { met: blank.met, detail: blank.detail }, blank.met === true);

  const project = process.env.KNITBRAIN_PROJECT_DIR;
  writeFileSync(join(project, 'a.ts'), 'export const alpha = 1;\n');
  const knowledge = context.knowledge;
  const before = knowledge.queryExports('a.ts');
  writeFileSync(join(project, 'a.ts'), 'export const beta = 2;\n');
  const after = knowledge.queryExports('a.ts');
  observe('KB-004', { before, after, expected: ['beta'] }, after.includes('alpha'));

  writeFileSync(join(project, 'substring.ts'), 'export const foobar = 1;\n');
  knowledge.scan();
  const claim = verifyClaim('substring.ts exports foo', knowledge);
  observe('KB-005', claim, claim.verdict === 'verified');

  const jsonContext = ctx('json');
  jsonContext.meter = { ...jsonContext.meter, read: () => ({ status: 'warn', advice: 'audit pressure fixture' }) };
  const jsonTool = { name: 'audit_json', output: 'data', run: () => '{"items":[1,2,3]}' };
  const json = dispatch(jsonTool, {}, jsonContext);
  let parseable = true;
  try { JSON.parse(json); } catch { parseable = false; }
  observe('KB-002', { parseable, advisoryAppended: json.includes('context-meter') }, !parseable);

  const meter = createMeter(join(root, 'lifecycle-meter'));
  meter.onSaved(10000);
  meter.onToolOutput(1000);
  const preReset = meter.read().optimizationPct;
  meter.reset();
  meter.onToolOutput(1000);
  observe('KB-006', { beforeResetPct: preReset, freshSessionPct: meter.read().optimizationPct, lifetimeSaved: meter.read().savedTokens }, meter.read().optimizationPct > 0);

  const pressure = createMeter(join(root, 'pressure-meter'), { windowTokens: 200000 });
  pressure.onToolOutput(210000);
  const reading = pressure.read();
  observe('KB-007', { configuredWindow: 200000, reportedWindow: reading.windowTokens, status: reading.status }, reading.windowTokens !== 200000 && reading.status === 'ok');

  const classify = ['Can you fix the bug?', 'Create a complete audit report and map needed fixes.'].map((task) => ({ task, tier: classifyTask(task).tier }));
  observe('KB-009', classify, classify.some((x) => x.tier === 'inquiry'));

  const skills = createSkillsStore(join(root, 'routing'));
  skills.save({ name: 'payments-discovery', body: 'payments research', triggers: ['map', 'evidence', 'payments'] });
  const selected = skills.find('map evidence for Knitbrain MCP correctness');
  observe('KB-010', { selected: selected?.name ?? null }, selected?.name === 'payments-discovery');

  const overheadContext = ctx('overhead');
  let overhead = null;
  for (let n = 4; n <= 100; n++) {
    const text = JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({ id: i, value: 'x'.repeat(12) })) });
    const r = compress(text, overheadContext.ccr);
    if (!r.compressed) continue;
    const emitted = dispatch(tool('knitbrain_optimize'), { text }, overheadContext);
    const emittedTokens = countTokens(emitted);
    if (emittedTokens > r.originalTokens) {
      overhead = { inputTokens: r.originalTokens, routerTokens: r.skeletonTokens, emittedTokens, reportedSaved: r.originalTokens - r.skeletonTokens };
      break;
    }
  }
  observe('KB-008', overhead ?? { expansionFound: false, samples: 97 }, overhead !== null);

  const opt = createOptimizer({ root: join(root, 'lib') });
  const documentedMethod = /const r = opt\.(\w+)\(/.exec(readFileSync(join(repo, 'README.md'), 'utf8'))?.[1];
  const documentedMethodAvailable = documentedMethod !== undefined && typeof opt[documentedMethod] === 'function';
  const original = 'audit library recall fixture\n'.repeat(200);
  const result = documentedMethodAvailable ? opt[documentedMethod](original) : null;
  const exactRecovery = result?.compressed && opt.retrieve(result.handle) === original;
  observe('KB-018', { documentedMethod, documentedMethodAvailable, exactRecovery: Boolean(exactRecovery) }, !documentedMethodAvailable || !exactRecovery);

  const recovery = createFileCCRStore(join(root, 'retention'));
  const handle = recovery.put('audit recall fixture');
  recovery.demote(handle);
  recovery.maintain({ coldMaxEntries: 0 });
  observe('KB-012', { recoverableAfterExplicitPurge: recovery.has(handle), note: 'Policy intentionally purges; default server also sets a cold cap.' }, !recovery.has(handle));

  client = new Client({ name: 'knitbrain-audit', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, 'dist/index.js')], cwd: project,
    env: { KNITBRAIN_HOME: join(root, 'stdio-home'), KNITBRAIN_PROJECT_DIR: project }, stderr: 'pipe' });
  await client.connect(transport);
  const invalid = await client.callTool({ name: 'knitbrain_optimize', arguments: {} });
  observe('KB-003', { invalidRequiredArgumentRejected: invalid.isError === true, content: invalid.content }, invalid.isError !== true);

  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), note: 'Diagnostic execution succeeded. defectPresent=true identifies an OPEN defect or documented policy limitation; this is NOT product green.', observations };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), serialized);
  console.log(serialized);
} finally {
  await client?.close();
  if (originalHome === undefined) delete process.env.KNITBRAIN_HOME; else process.env.KNITBRAIN_HOME = originalHome;
  if (originalProject === undefined) delete process.env.KNITBRAIN_PROJECT_DIR; else process.env.KNITBRAIN_PROJECT_DIR = originalProject;
  rmSync(root, { recursive: true, force: true });
}
