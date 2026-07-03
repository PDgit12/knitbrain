import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runClosedLoop, defaultJudge, makeGrade, makeReview } from "./engine/closed-loop.js";
import { createWikiStore } from "./engine/wiki.js";
import { createSkillsStore, type SkillsStore } from "./engine/skills.js";
import { createKnowledge, type Knowledge } from "./engine/knowledge.js";
import { proposeAgents } from "./engine/agents.js";
import { classifyTask } from "./engine/workflow.js";
import { wikiRoot, skillsRoot, knowledgeRoot } from "./paths.js";
import { currentContextTokens } from "./engine/usage.js";

/**
 * Plan for one orchestration cycle — orchestration scales with project
 * INTENSITY: trivial/standard tasks get the matched skill only; complex tasks
 * also get guardrailed agent proposals briefed into the prompt. Pure (stores
 * injected) so the prompt composition is testable without spawning an agent.
 */
export interface CyclePlan {
  tier: string;
  skillName: string | null;
  agentNames: string[];
  prompt: string;
}

export function buildCyclePlan(goalText: string, skills: SkillsStore, knowledge: Knowledge): CyclePlan {
  const cls = classifyTask(goalText, []);
  const skill = skills.find(goalText);
  const agents = cls.tier === "complex" ? proposeAgents(knowledge.listFiles()).slice(0, 4) : [];

  let prompt = `Goal:\n${goalText}\n\n`;
  if (skill) {
    prompt += `SKILL — ${skill.name}:\n${skill.body}\n`;
    if (skill.constraints.length) prompt += `CONSTRAINTS (non-negotiable):\n${skill.constraints.map((c) => `- ${c}`).join("\n")}\n`;
    prompt += "\n";
  }
  if (agents.length) {
    prompt += `AGENTS to orchestrate (complex task — spawn via your host's sub-agent mechanism):\n`;
    prompt += agents
      .map((a) => `- ${a.name}: scope \`${a.scope}\` · tools ${a.tools.join("/")}${a.reviewGate ? " · REVIEW-GATED" : ""}`)
      .join("\n");
    prompt += "\n\n";
  }
  prompt += "Make progress, then stop. Do NOT declare the goal met yourself — the loop grades (verify) + reviews. Do NOT commit, push, or deploy.";

  return { tier: cls.tier, skillName: skill?.name ?? null, agentNames: agents.map((a) => a.name), prompt };
}

/**
 * `knitbrain orchestrate <goalfile>` — the closed-loop orchestrator (P3).
 * goal → judge → iterate → grade → review → repeat until met (or max cap).
 *
 * Composes the real steps: the agent does the work (iterate), the verify
 * command is the grade (real run, no false green), a rubric is the review, the
 * wiki gets a per-cycle audit trail, and the live token window is metered.
 * Like the outer loop, it NEVER commits/pushes/deploys — the human does that.
 */

interface Opts {
  goalFile?: string;
  max: number;
  agent: string;
  verify: string | null;
}

function parseArgs(args: string[]): Opts {
  const o: Opts = { max: 6, agent: "claude -p", verify: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--max") o.max = Math.max(1, Number(args[(i += 1)]) || 6);
    else if (a === "--agent") o.agent = args[(i += 1)] ?? o.agent;
    else if (a === "--verify") o.verify = args[(i += 1)] ?? null;
    else if (a && !a.startsWith("--")) o.goalFile = a;
  }
  return o;
}

const run = (cmd: string, input?: string): boolean =>
  spawnSync(cmd, { shell: true, input, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"] }).status === 0;

export function runOrchestrate(args: string[]): number {
  const o = parseArgs(args);
  if (!o.goalFile || !existsSync(o.goalFile)) {
    console.error('usage: knitbrain orchestrate <goalfile.md> [--max N=6] [--agent "cmd"] [--verify "cmd"]');
    console.error("  goal → judge → iterate → grade → review → repeat until met. Never commits/pushes/deploys.");
    return 1;
  }
  const goalText = readFileSync(o.goalFile, "utf8");
  const verify = o.verify ?? (existsSync("package.json") ? "npm test" : "");
  const wiki = createWikiStore(wikiRoot());
  // Intensity-based orchestration: the classifier + skill + agents drive the prompt.
  const skills = createSkillsStore(skillsRoot());
  const knowledge = createKnowledge(process.cwd(), knowledgeRoot());

  console.log(`[orchestrate] goal: ${o.goalFile} · verify: ${verify || "(none)"} · max ${o.max} cycles`);

  const result = runClosedLoop(
    {
      judge: () => defaultJudge(goalText, (verify || "").trim().length > 0),
      iterate: (iter) => {
        const plan = buildCyclePlan(goalText, skills, knowledge);
        console.log(`[orchestrate] cycle ${iter}: iterate · tier=${plan.tier} · skill=${plan.skillName ?? "none"} · agents=${plan.agentNames.length}`);
        run(o.agent, plan.prompt);
      },
      grade: makeGrade(verify, (cmd) => run(cmd)),
      review: makeReview(),
      onCycle: (c) => {
        wiki.log("cycle", `${o.goalFile} · iter ${c.iter} · grade=${c.graded.pass} · met=${c.met} · tokens=${c.tokens ?? "?"}`);
        console.log(`[orchestrate] cycle ${c.iter}: grade=${c.graded.pass} review=${c.reviewed.notes} met=${c.met}${c.tokens != null ? ` · ${c.tokens} ctx tokens` : ""}`);
      },
      meter: () => currentContextTokens() ?? 0,
    },
    o.max,
  );

  // Synthesize the run into the wiki so the orchestration compounds.
  wiki.ingest({
    title: `orchestration ${o.goalFile}`,
    kind: "session",
    content: `Closed loop on ${o.goalFile}.\n- claim: met = ${result.met}\ncycles: ${result.cycles.length} · ${result.reason}`,
  });

  console.log(`[orchestrate] ${result.met ? "MET ✓" : "NOT met ✗"} — ${result.reason}`);
  if (!result.met) console.log("[orchestrate] no false green: goal not marked met. Re-run to continue, or refine the goal.");
  return result.met ? 0 : 1;
}
