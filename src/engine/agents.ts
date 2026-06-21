import { mkdirSync } from "node:fs";
import { writeAtomic } from "../atomic.js";
import { dirname, join } from "node:path";

/** Domains that warrant a mandatory review/verify gate before edits. */
const SENSITIVE = /\b(auth|security|secret|payment|billing|crypto|db|database|migration|schema)\b/i;

export interface DomainProposal {
  /** Short domain name (e.g. "proxy"). */
  name: string;
  /** Glob the agent is scoped to (guardrail #1). */
  scope: string;
  /** Files detected in the domain. */
  files: string[];
  /** Suggested tool allowlist (guardrail #2). */
  tools: string[];
  /** Whether a review/verify gate is recommended (guardrail #3). */
  reviewGate: boolean;
  /** Suggested context-token budget (guardrail #4). */
  contextBudget: number;
}

export interface AgentSpec {
  name: string;
  description?: string;
  scope?: string;
  tools?: string[];
  reviewGate?: boolean;
  contextBudget?: number;
  /** Mission brief for THIS task — telegraphic skill body, not a context dump
   * (sub-agents start cold; the brief is their whole task-specific context,
   * so it's optimized prompt-by-prompt like everything else). */
  brief?: string;
}

const DEFAULT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"];

/**
 * Auto-detect candidate domain agents from the knowledge graph: group source
 * files by their directory; each directory with ≥2 files becomes a proposal
 * with sensible, project-specific guardrails. The agent then interviews the
 * user to confirm/edit before create_agent writes them.
 */
export function proposeAgents(files: string[]): DomainProposal[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    if (dir === "." || dir === "") continue;
    const arr = byDir.get(dir);
    if (arr) arr.push(f);
    else byDir.set(dir, [f]);
  }
  const proposals: DomainProposal[] = [];
  for (const [dir, dirFiles] of byDir) {
    if (dirFiles.length < 2) continue;
    const name = dir.split("/").pop()!;
    const reviewGate = SENSITIVE.test(dir);
    proposals.push({
      name,
      scope: `${dir}/**`,
      files: dirFiles,
      tools: reviewGate ? ["Read", "Grep", "Glob"] : DEFAULT_TOOLS,
      reviewGate,
      contextBudget: 8000,
    });
  }
  return proposals.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render a project-specific subagent definition with all four guardrails baked
 * in: file/domain scope, allowed-tools allowlist, review gate, context budget.
 */
export function generateAgentMarkdown(spec: AgentSpec): string {
  const tools = (spec.tools ?? DEFAULT_TOOLS).join(", ");
  const scope = spec.scope ?? "(whole project)";
  const budget = spec.contextBudget ?? 8000;
  const description = spec.description ?? `Project agent scoped to ${scope}.`;
  const gate = spec.reviewGate
    ? "- **Review gate:** this is a sensitive domain — before any edit, re-verify the exact source (knitbrain_query_dependents + read the real file via knitbrain_retrieve) and have the change reviewed.\n"
    : "";
  return `---
name: ${spec.name}
description: ${description}
tools: ${tools}
---

You are the **${spec.name}** agent for this project.

## Guardrails
- **Scope:** only touch files under \`${scope}\`. Do not edit outside this domain.
- **Allowed tools:** ${tools}.
${gate}- **Context budget:** keep your working context under ~${budget} tokens. For large payloads, call \`knitbrain_optimize\` and page originals back with \`knitbrain_retrieve\` only when needed.

${spec.brief ? `## Mission brief (telegraphic — full context one retrieve away)\n${spec.brief}\n\n` : ""}## How to work
1. Ground yourself: \`knitbrain_query_imports\` / \`knitbrain_query_dependents\` before editing.
2. Make the smallest correct change within scope.
3. Post findings to \`knitbrain_team_post\` so the orchestrator and sibling agents see them.
4. Record non-obvious findings with \`knitbrain_record_learning\`.
`;
}

/** Write a generated agent to the project's .claude/agents directory. */
export function writeAgent(projectRoot: string, spec: AgentSpec): string {
  // SECURITY: the name becomes a filename — restrict to a safe slug so it can
  // never escape .claude/agents (no separators, dots, or empty names).
  const safeName = spec.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (safeName.length === 0) throw new Error(`invalid agent name: ${JSON.stringify(spec.name)}`);
  const dir = join(projectRoot, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeName}.md`);
  spec = { ...spec, name: safeName };
  writeAtomic(path, generateAgentMarkdown(spec));
  return path;
}
