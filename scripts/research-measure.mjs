/**
 * Research worker — ONE measurement in a FRESH process, so WASM/heap state
 * never accumulates across experiments (the autoresearch-faithful design:
 * each experiment is isolated). Parameter overrides arrive via the KNITBRAIN_*
 * env vars that src/optimizer/params.ts already reads at load. Prints a single
 * JSON line: {savings, pass, blocks}. Run by scripts/research.mjs.
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (p) => pathToFileURL(join(ROOT, "dist", p)).href;
const { runProfile } = await import(distUrl("profile.js"));
const { runEvals } = await import(distUrl("evals.js"));

const noop = () => {};
const corpus = process.argv[2] ? [process.argv[2]] : [];
const savings = await runProfile(corpus, noop);
const evals = await runEvals(corpus, noop);
process.stdout.write(JSON.stringify({ savings, pass: evals.pass, blocks: evals.blocks }));
