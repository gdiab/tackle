import type { PhaseName } from "./types.js";

export interface PhaseDef {
  name: PhaseName;
  /** Artifact this phase writes, relative to the workdir. */
  artifact: string;
  /** Clarifying-questions file for this phase, relative to the workdir. */
  questionsFile: string;
  /** Prior-phase artifacts inlined into this phase's prompt (selective load). */
  inputs: PhaseName[];
  /** Phase that must be approved before this one runs, in the full spine. */
  predecessor: PhaseName | null;
  /** CLI flag that lets a workflow start at this phase (null = specs is the default entry). */
  entryFlag: "--skip-specs" | "--trivial" | null;
}

export const PHASE_ORDER: PhaseName[] = ["specs", "plan", "build", "review", "pr"];

export const BUILD_DIFF_FILE = ".tackle/build.diff";

export const SPINE: Record<PhaseName, PhaseDef> = {
  specs: {
    name: "specs",
    artifact: ".tackle/specs.md",
    questionsFile: ".tackle/specs-questions.md",
    inputs: [],
    predecessor: null,
    entryFlag: null,
  },
  plan: {
    name: "plan",
    artifact: ".tackle/plan.md",
    questionsFile: ".tackle/plan-questions.md",
    inputs: ["specs"],
    predecessor: "specs",
    entryFlag: "--skip-specs",
  },
  build: {
    name: "build",
    artifact: ".tackle/build-notes.md",
    questionsFile: ".tackle/build-questions.md",
    inputs: ["plan"],
    predecessor: "plan",
    entryFlag: "--trivial",
  },
  review: {
    name: "review",
    artifact: ".tackle/review.md",
    // unused by the review runner (review never asks clarifying questions);
    // present because PhaseDef requires it and the invalidation loop removes it.
    questionsFile: ".tackle/review-questions.md",
    // the review runner assembles its own inputs (frozen diff + spec), so none here
    inputs: [],
    predecessor: "build",
    entryFlag: null,
  },
  pr: {
    name: "pr",
    artifact: ".tackle/pr.md",
    questionsFile: ".tackle/pr-questions.md",
    inputs: ["specs", "build"],
    predecessor: "review",
    entryFlag: null,
  },
};

/**
 * The predecessor that actually exists in this workflow: phases before the
 * entry point were skipped by design (bug fixes skip specs, trivial changes
 * skip to build), so they can't be required.
 */
export function effectivePredecessor(phase: PhaseName, entry: PhaseName): PhaseName | null {
  if (phase === entry) return null;
  const pred = SPINE[phase].predecessor;
  if (pred === null) return null;
  return PHASE_ORDER.indexOf(pred) < PHASE_ORDER.indexOf(entry) ? null : pred;
}
