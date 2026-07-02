import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPhase } from "../src/workflow/phase.js";
import { readWorkflowState } from "../src/workflow/state.js";
import {
  approveAll,
  fakeTurn,
  rejectAll,
  scriptedAdapter,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

describe("clarification round-trip", () => {
  it("halts with needs_clarification when questions are written instead of the artifact", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      async (req) => {
        // .tackle/ exists: workflow.json was written before the turn
        await writeFile(join(req.workdir, ".tackle", "specs-questions.md"), "- which env?");
        return fakeTurn({ summary: "asked questions" });
      },
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "vague ask",
    });
    expect(outcome).toBe("needs_clarification");
    expect(adapter.prompts).toHaveLength(1); // clarification is not a retryable failure
    expect((await readWorkflowState(dir))?.phases.specs?.status).toBe("needs_clarification");
  });

  it("carries the answered questions into the next run's prompt", async () => {
    const dir = await tempWorkdir();
    const first = scriptedAdapter([
      async (req) => {
        await writeFile(join(req.workdir, ".tackle", "specs-questions.md"), "- which env?");
        return fakeTurn();
      },
    ]);
    await runPhase({
      phase: "specs", workdir: dir, adapter: first, presenter: approveAll, canEnter: true, request: "vague ask",
    });
    // the human answers in place
    await writeFile(join(dir, ".tackle", "specs-questions.md"), "- which env? A: prod");
    const second = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter: second, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("approved");
    expect(second.prompts[0]).toContain("## Clarifying questions and answers");
    expect(second.prompts[0]).toContain("A: prod");
  });
});

describe("entry, resume, and invalidation", () => {
  it("plan --skip-specs starts a workflow entered at plan with no predecessor", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan")]);
    const outcome = await runPhase({
      phase: "plan", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "fix the crash",
    });
    expect(outcome).toBe("approved");
    expect((await readWorkflowState(dir))?.entry).toBe("plan");
  });

  it("refuses a non-entry phase with no workflow in progress", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/pr.md", "# pr")]);
    const outcome = await runPhase({
      phase: "pr", workdir: dir, adapter, presenter: approveAll, canEnter: false,
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(0);
  });

  it("refuses a phase that precedes the workflow's entry point", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "plan", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan")]),
      presenter: approveAll, canEnter: true, request: "fix",
    });
    const specsAdapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter: specsAdapter, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("halted");
    expect(specsAdapter.prompts).toHaveLength(0);
  });

  it("blocks a phase whose predecessor has not run", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]),
      presenter: approveAll, canEnter: true, request: "r",
    });
    const buildAdapter = scriptedAdapter([writesArtifact(".tackle/build-notes.md", "# notes")]);
    const outcome = await runPhase({
      phase: "build", workdir: dir, adapter: buildAdapter, presenter: approveAll, canEnter: false,
    });
    expect(outcome).toBe("halted"); // plan never ran
    expect(buildAdapter.prompts).toHaveLength(0);
  });

  it("re-presents a pending predecessor gate before running (resume path)", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]),
      presenter: rejectAll, canEnter: true, request: "r",
    }); // specs left awaiting_approval, as after a kill
    const planAdapter = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan")]);
    const outcome = await runPhase({
      phase: "plan", workdir: dir, adapter: planAdapter, presenter: approveAll, canEnter: false,
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.phases.specs?.status).toBe("approved");
    expect(state?.phases.plan?.status).toBe("approved");
    expect(planAdapter.prompts[0]).toContain("# specs"); // approved spec was inlined
  });

  it("re-presents this phase's own pending gate instead of re-running the turn", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: rejectAll, canEnter: true, request: "r",
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts).toHaveLength(1); // no second turn
  });

  it("--redo re-runs an approved phase and invalidates downstream artifacts", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs v1")]),
      presenter: approveAll, canEnter: true, request: "r",
    });
    await runPhase({
      phase: "plan", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan v1")]),
      presenter: approveAll, canEnter: false,
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs v2")]),
      presenter: approveAll, canEnter: true, redo: true,
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.phases.plan).toBeUndefined(); // downstream state invalidated
    await expect(readFile(join(dir, ".tackle", "plan.md"), "utf8")).rejects.toThrow(); // artifact removed
    expect(await readFile(join(dir, ".tackle", "specs.md"), "utf8")).toBe("# specs v2");
  });

  it("--fresh discards the old workflow and its artifacts", async () => {
    const dir = await tempWorkdir();
    await runPhase({
      phase: "plan", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/plan.md", "# old plan")]),
      presenter: approveAll, canEnter: true, request: "old",
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir,
      adapter: scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]),
      presenter: approveAll, canEnter: true, request: "new", fresh: true,
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.entry).toBe("specs");
    expect(state?.request).toBe("new");
    expect(state?.phases.plan).toBeUndefined();
    await expect(readFile(join(dir, ".tackle", "plan.md"), "utf8")).rejects.toThrow();
  });

  it("already-approved phase without --redo is a no-op returning approved", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true,
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts).toHaveLength(1);
  });
});
