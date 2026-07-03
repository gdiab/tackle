import type { PhaseDef } from "./spine.js";
import type { PhaseName } from "./types.js";
import type { Finding } from "./verdict.js";

export interface PromptOptions {
  def: PhaseDef;
  request: string;
  inputs: Array<{ name: string; path: string; content: string }>;
  /** Content of the questions file (agent questions + human answers), when it exists. */
  questionsAndAnswers?: string;
  /** Set on deterministic-retry attempts to tell the agent what went wrong. */
  retryNote?: string;
}

// review never runs through a turn prompt (its runner assembles its own agent
// interaction), so it is excluded from the phases buildPhasePrompt supports.
export type TurnPhase = Exclude<PhaseName, "review">;

const PHASE_INSTRUCTIONS: Record<TurnPhase, (def: PhaseDef) => string> = {
  specs: (def) =>
    `You are running the specs phase of a phase-gated development workflow. ` +
    `Produce a requirements document for the request below: the problem, the desired behavior, ` +
    `acceptance criteria, non-goals, and open risks. Be concrete enough that a planning pass can ` +
    `work from this document alone. Write the document to ${def.artifact}. ` +
    `Do not modify any other files and do not change source code.`,
  plan: (def) =>
    `You are running the plan phase of a phase-gated development workflow. ` +
    `From the inputs below, produce a step-by-step implementation plan: the files to create or ` +
    `modify, the change in each, the test strategy per step, and commit points. The plan is the ` +
    `primary review artifact — reviewing it is cheaper than reviewing the code it produces, so make ` +
    `it complete enough to judge on its own. Write it to ${def.artifact}. ` +
    `Do not modify any other files and do not change source code.`,
  build: (def) =>
    `You are running the build phase of a phase-gated development workflow. ` +
    `Implement the plan below in this repository, test-first where a test is practical. ` +
    `Do not commit; leave all changes in the working tree — the harness captures the diff as the ` +
    `artifact of record. When done, write ${def.artifact} summarizing what changed, decisions taken, ` +
    `any deviations from the plan, and how you verified the change (tests run and their results).`,
  pr: (def) =>
    `You are running the pr phase of a phase-gated development workflow. ` +
    `Using the inputs below and the repository's current state (inspect \`git diff\` and \`git status\` ` +
    `yourself as needed), write a pull-request body to ${def.artifact}: a summary of the change, the ` +
    `motivation against the spec, test evidence, and any known gaps. ` +
    `Do not modify any other files and do not change source code.`,
};

export function buildPhasePrompt(opts: PromptOptions): string {
  const { def } = opts;
  if (def.name === "review") {
    throw new Error("the review phase runs through runReviewPhase, not turn prompts");
  }
  const sections: string[] = [
    PHASE_INSTRUCTIONS[def.name](def),
    // SPEC.md clarification precondition: detect-ask-wait instead of guessing.
    `Before doing anything else, assess whether your input is complete and unambiguous enough to act ` +
      `on responsibly. If it is not, write your clarifying questions to ${def.questionsFile} as a ` +
      `markdown list and stop: do not write ${def.artifact} and do not make any other changes.`,
    `## Request\n\n${opts.request}`,
  ];
  for (const input of opts.inputs) {
    sections.push(`## Input: ${input.name} (${input.path})\n\n${input.content}`);
  }
  if (opts.questionsAndAnswers !== undefined) {
    sections.push(
      `## Clarifying questions and answers\n\nThese are your questions from an earlier attempt, ` +
        `with the human's answers added. Treat the answers as authoritative.\n\n${opts.questionsAndAnswers}`,
    );
  }
  if (opts.retryNote !== undefined) {
    sections.push(`## Previous attempt\n\n${opts.retryNote}`);
  }
  return sections.join("\n\n");
}

export function buildReviewPrompt(opts: {
  diff: string;
  requirement: { label: string; content: string };
}): string {
  return [
    `You are the cross-model review gate of a phase-gated development workflow. Review the diff ` +
      `below — the complete, frozen output of a build phase — against the requirement that follows. ` +
      `You have no tools; everything you need is in this prompt. Do not modify any files.`,
    `Report as "blocking" severity: correctness bugs; the diff not implementing the requirement; ` +
      `missed simplifications — could the change be reframed so whole branches disappear?; and ` +
      `structural explosions — a file crossing roughly 1,000 lines is a finding, not a shrug. ` +
      `Report genuine but non-gating improvements as "note" severity.`,
    `End your reply with exactly one fenced json block in this shape:\n\n` +
      "```json\n" +
      `{ "verdict": "clean", "findings": [{ "severity": "blocking", "file": "path/to/file.ts", ` +
      `"line": 123, "summary": "one line", "detail": "why, and what to do instead" }] }\n` +
      "```\n\n" +
      `Use verdict "clean" only when there are no blocking findings; otherwise use "findings". ` +
      `"line" and "detail" are optional.`,
    `## Requirement: ${opts.requirement.label}\n\n${opts.requirement.content}`,
    `## Diff under review\n\n\`\`\`diff\n${opts.diff}\n\`\`\``,
  ].join("\n\n");
}

export function buildFixPrompt(opts: { findings: Finding[]; request: string }): string {
  const list = opts.findings
    .map(
      (f) =>
        `- ${f.file}${f.line === undefined ? "" : `:${f.line}`} — ${f.summary}` +
        (f.detail === undefined ? "" : `\n  ${f.detail}`),
    )
    .join("\n");
  return [
    `You are running a fix turn in the review phase of a phase-gated development workflow. A ` +
      `cross-model review of the uncommitted changes in this repository found blocking findings. ` +
      `Fix all of them in the working tree. Do not commit; leave every change uncommitted — the ` +
      `harness re-freezes the diff and re-reviews it. Do not weaken or delete tests to satisfy a finding.`,
    `## Original request\n\n${opts.request}`,
    `## Blocking findings\n\n${list}`,
  ].join("\n\n");
}
