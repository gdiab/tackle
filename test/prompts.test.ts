import { describe, expect, it } from "vitest";
import { buildFixPrompt, buildPhasePrompt, buildReviewPrompt } from "../src/workflow/prompts.js";
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

  it("build prompt gains the map section when a test map exists", () => {
    const prompt = buildPhasePrompt({
      def: SPINE.build,
      request: "r",
      inputs: [],
      testMapPath: ".tackle/test-map.json",
    });
    expect(prompt).toContain("## Source-to-test map");
    expect(prompt).toContain(".tackle/test-map.json");
    expect(prompt).toContain("tackle map query");
    expect(prompt).toContain("write a failing test first");
  });

  it("build prompt stays advisory-only without a map; other phases never get the section", () => {
    expect(buildPhasePrompt({ def: SPINE.build, request: "r", inputs: [] })).not.toContain(
      "## Source-to-test map",
    );
    expect(
      buildPhasePrompt({ def: SPINE.plan, request: "r", inputs: [], testMapPath: ".tackle/test-map.json" }),
    ).not.toContain("## Source-to-test map");
  });
});

describe("review prompts", () => {
  it("inlines the diff and requirement, demands the verdict block, forbids writes", () => {
    const p = buildReviewPrompt({ diff: "+added line", requirement: { label: "specs (.tackle/specs.md)", content: "must render" } });
    expect(p).toContain("+added line");
    expect(p).toContain("must render");
    expect(p).toContain('"verdict"');
    expect(p).toContain("Do not modify any files");
    expect(p).toContain("simplifications"); // structural posture
  });

  it("fix prompt lists findings and forbids committing", () => {
    const p = buildFixPrompt({
      findings: [{ severity: "blocking", file: "src/a.ts", line: 3, summary: "off by one", detail: "loop bound" }],
      request: "add widget",
    });
    expect(p).toContain("src/a.ts:3");
    expect(p).toContain("off by one");
    expect(p).toContain("Do not commit");
    expect(p).toContain("add widget");
  });
});
