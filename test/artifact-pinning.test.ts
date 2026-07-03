import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPhase } from "../src/workflow/phase.js";
import { sha256 } from "../src/workflow/hash.js";
import {
  approveAll,
  capturingPresenter,
  rejectAll,
  scriptedAdapter,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

describe("artifact pinning at approval", () => {
  it("records the artifact hash when a gate is approved", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r" });
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.artifactHash).toBe(sha256("# specs\n"));
  });

  it("pins the frozen diff hash when the build gate is approved", async () => {
    const dir = await tempWorkdir();
    const diff = "diff --git a/x b/x\n+x\n";
    const adapter = scriptedAdapter([
      writesArtifact(".tackle/build-notes.md", "# notes\n", { workdirDiff: diff }),
    ]);
    await runPhase({ phase: "build", workdir: dir, adapter, presenter: approveAll, canEnter: true, request: "r" });
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.build.diffHash).toBe(sha256(diff));
  });

  it("halts a phase whose approved input artifact was modified after approval", async () => {
    const dir = await tempWorkdir();
    const specs = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter: specs, presenter: approveAll, canEnter: true, request: "r" });
    await writeFile(join(dir, ".tackle", "specs.md"), "# tampered\n"); // post-approval rewrite
    const presenter = capturingPresenter(true);
    const plan = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan\n")]);
    const outcome = await runPhase({ phase: "plan", workdir: dir, adapter: plan, presenter, canEnter: false });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("changed after specs was approved");
  });

  it("halts a phase whose approved input artifact was emptied after approval", async () => {
    const dir = await tempWorkdir();
    const specs = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter: specs, presenter: approveAll, canEnter: true, request: "r" });
    await writeFile(join(dir, ".tackle", "specs.md"), "");
    const presenter = capturingPresenter(true);
    const plan = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan\n")]);
    const outcome = await runPhase({ phase: "plan", workdir: dir, adapter: plan, presenter, canEnter: false });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("missing or blank but specs was approved");
  });

  it("accepts an unmodified approved input", async () => {
    const dir = await tempWorkdir();
    const specs = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    await runPhase({ phase: "specs", workdir: dir, adapter: specs, presenter: approveAll, canEnter: true, request: "r" });
    const plan = scriptedAdapter([writesArtifact(".tackle/plan.md", "# plan\n")]);
    const outcome = await runPhase({ phase: "plan", workdir: dir, adapter: plan, presenter: approveAll, canEnter: false });
    expect(outcome).toBe("approved");
  });

  it("presentGate fails closed when the artifact is deleted while awaiting approval", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    // leaves specs awaiting_approval (gate rejected, artifact never approved/pinned)
    await runPhase({ phase: "specs", workdir: dir, adapter, presenter: rejectAll, canEnter: true, request: "r" });
    await rm(join(dir, ".tackle", "specs.md")); // artifact deleted while awaiting_approval
    const presenter = capturingPresenter(true);
    const outcome = await runPhase({ phase: "specs", workdir: dir, adapter, presenter, canEnter: true });
    expect(outcome).toBe("rejected");
    expect(presenter.messages.join("\n")).toContain("missing or blank; cannot present");
    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.status).toBe("awaiting_approval");
    expect(state.phases.specs.artifactHash).toBeUndefined();
  });
});
