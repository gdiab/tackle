import type { PhaseDef } from "./spine.js";
import type { PhaseName } from "./types.js";

export interface PromptOptions {
  def: PhaseDef;
  request: string;
  inputs: Array<{ name: string; path: string; content: string }>;
  /** Content of the questions file (agent questions + human answers), when it exists. */
  questionsAndAnswers?: string;
  /** Set on deterministic-retry attempts to tell the agent what went wrong. */
  retryNote?: string;
}

const PHASE_INSTRUCTIONS: Record<PhaseName, (def: PhaseDef) => string> = {
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
