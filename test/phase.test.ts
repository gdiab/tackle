import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_USAGE } from "../src/adapter/types.js";
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

describe("runPhase deterministic gates", () => {
  it("happy path: runs the turn, records authorship, and approves at the gate", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "add a widget",
    });
    expect(outcome).toBe("approved");
    const state = await readWorkflowState(dir);
    expect(state?.phases.specs?.status).toBe("approved");
    expect(state?.phases.specs?.lastTurn?.authorship.adapter).toBe("fake");
    expect(state?.request).toBe("add a widget");
    expect(adapter.prompts[0]).toContain("running the specs phase");
  });

  it("retries once when the artifact was not written, with a retry note", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      async () => fakeTurn(), // completed but wrote nothing
      writesArtifact(".tackle/specs.md", "# specs"),
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts).toHaveLength(2);
    expect(adapter.prompts[1]).toContain("## Previous attempt");
  });

  it("retries once on a non-completed turn status", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      async () => fakeTurn({ status: "tool_error" }),
      writesArtifact(".tackle/specs.md", "# specs"),
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("approved");
    expect(adapter.prompts[1]).toContain('status "tool_error"');
  });

  it("halts after the retry budget is exhausted and records the halted state", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([async () => fakeTurn({ status: "timeout" })]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(2); // 1 attempt + deterministicRetries(1)
    expect((await readWorkflowState(dir))?.phases.specs?.status).toBe("halted");
  });

  it("halts immediately on a metered turn without retrying (billing gate)", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([
      writesArtifact(".tackle/specs.md", "# specs", {
        usage: { tokens: EMPTY_USAGE, billingType: "metered" },
      }),
    ]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(1);
  });

  it("respects deterministicRetries from .tackle/config.json", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle"), { recursive: true });
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ deterministicRetries: 0 }));
    const adapter = scriptedAdapter([async () => fakeTurn({ status: "timeout" })]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("halted");
    expect(adapter.prompts).toHaveLength(1);
  });

  it("freezes the build diff to .tackle/build.diff", async () => {
    const dir = await tempWorkdir();
    const diff = "diff --git a/x.ts b/x.ts\n+added\n";
    // enter at build (trivial change) so no predecessors are required
    const adapter = scriptedAdapter([
      writesArtifact(".tackle/build-notes.md", "# notes", { workdirDiff: diff }),
    ]);
    const outcome = await runPhase({
      phase: "build", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "tiny fix",
    });
    expect(outcome).toBe("approved");
    expect(await readFile(join(dir, ".tackle", "build.diff"), "utf8")).toBe(diff);
  });

  it("declined approval leaves the phase awaiting_approval and returns rejected", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs")]);
    const outcome = await runPhase({
      phase: "specs", workdir: dir, adapter, presenter: rejectAll, canEnter: true, request: "r",
    });
    expect(outcome).toBe("rejected");
    expect((await readWorkflowState(dir))?.phases.specs?.status).toBe("awaiting_approval");
  });
});
