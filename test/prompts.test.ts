import { describe, expect, it } from "vitest";
import { buildPhasePrompt } from "../src/workflow/prompts.js";
import { PHASE_ORDER, SPINE } from "../src/workflow/spine.js";

describe("buildPhasePrompt", () => {
  it("every turn-phase prompt names the phase, its artifact, and its questions file", () => {
    // review has no turn prompt: its runner assembles its own agent interaction (see below).
    for (const phase of PHASE_ORDER.filter((p) => p !== "review")) {
      const def = SPINE[phase];
      const prompt = buildPhasePrompt({ def, request: "do the thing", inputs: [] });
      expect(prompt).toContain(`running the ${phase} phase`);
      expect(prompt).toContain(def.artifact);
      expect(prompt).toContain(def.questionsFile);
      expect(prompt).toContain("## Request\n\ndo the thing");
    }
  });

  it("refuses to build a turn prompt for the review phase", () => {
    expect(() => buildPhasePrompt({ def: SPINE.review, request: "r", inputs: [] })).toThrow(/runReviewPhase/);
  });

  it("inlines each input artifact under a labeled section", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.plan,
      request: "r",
      inputs: [{ name: "specs", path: ".tackle/specs.md", content: "# the spec" }],
    });
    expect(prompt).toContain("## Input: specs (.tackle/specs.md)");
    expect(prompt).toContain("# the spec");
  });

  it("carries clarifying Q&A back into the prompt when present", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.specs,
      request: "r",
      inputs: [],
      questionsAndAnswers: "- Q: which env? A: prod",
    });
    expect(prompt).toContain("## Clarifying questions and answers");
    expect(prompt).toContain("- Q: which env? A: prod");
  });

  it("appends the retry note on a retry attempt", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.build,
      request: "r",
      inputs: [],
      retryNote: "The previous attempt completed without writing .tackle/build-notes.md.",
    });
    expect(prompt).toContain("## Previous attempt");
    expect(prompt).toContain("without writing .tackle/build-notes.md");
  });

  it("build prompt forbids committing; pr prompt allows inspecting the repo", () => {
    expect(buildPhasePrompt({ def: SPINE.build, request: "r", inputs: [] })).toContain("Do not commit");
    expect(buildPhasePrompt({ def: SPINE.pr, request: "r", inputs: [] })).toContain("git diff");
  });
});
