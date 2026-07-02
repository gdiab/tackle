import { describe, expect, it } from "vitest";
import { BUILD_DIFF_FILE, effectivePredecessor, PHASE_ORDER, SPINE } from "../src/workflow/spine.js";

describe("spine", () => {
  it("orders the phases specs -> plan -> build -> pr", () => {
    expect(PHASE_ORDER).toEqual(["specs", "plan", "build", "pr"]);
  });

  it("names the SPEC.md artifacts", () => {
    expect(SPINE.specs.artifact).toBe(".tackle/specs.md");
    expect(SPINE.plan.artifact).toBe(".tackle/plan.md");
    expect(SPINE.build.artifact).toBe(".tackle/build-notes.md");
    expect(SPINE.pr.artifact).toBe(".tackle/pr.md");
    expect(BUILD_DIFF_FILE).toBe(".tackle/build.diff");
  });

  it("loads selectively: each phase names only the inputs it needs", () => {
    expect(SPINE.specs.inputs).toEqual([]);
    expect(SPINE.plan.inputs).toEqual(["specs"]);
    expect(SPINE.build.inputs).toEqual(["plan"]);
    expect(SPINE.pr.inputs).toEqual(["specs", "build"]);
  });

  it("computes the effective predecessor from the entry point", () => {
    expect(effectivePredecessor("plan", "specs")).toBe("specs");
    expect(effectivePredecessor("plan", "plan")).toBeNull(); // entered here: no predecessor
    expect(effectivePredecessor("build", "plan")).toBe("plan");
    expect(effectivePredecessor("pr", "build")).toBe("build");
    expect(effectivePredecessor("specs", "specs")).toBeNull();
  });
});
