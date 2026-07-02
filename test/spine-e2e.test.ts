import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { approveAll, fakeTurn, rejectAll } from "./helpers/workflow.js";

const BUILD_DIFF = "diff --git a/w.ts b/w.ts\n+export const w = 1;\n";

/** Plays each phase by keying on the prompt's "running the <phase> phase" marker. */
function phasePlayingAdapter(): Adapter {
  return {
    name: "fake",
    run: async (req: TurnRequest) => {
      const t = join(req.workdir, ".tackle");
      await mkdir(t, { recursive: true });
      if (req.prompt.includes("running the specs phase")) {
        await writeFile(join(t, "specs.md"), "# specs: widget\nacceptance: renders\n");
        return fakeTurn({ summary: "wrote specs" });
      }
      if (req.prompt.includes("running the plan phase")) {
        expect(req.prompt).toContain("# specs: widget"); // selective load carried the spec in
        await writeFile(join(t, "plan.md"), "# plan: add w.ts\n");
        return fakeTurn({ summary: "wrote plan" });
      }
      if (req.prompt.includes("running the build phase")) {
        expect(req.prompt).toContain("# plan: add w.ts");
        await writeFile(join(t, "build-notes.md"), "# notes: added w.ts, tests pass\n");
        return fakeTurn({ summary: "built it", workdirDiff: BUILD_DIFF });
      }
      if (req.prompt.includes("running the pr phase")) {
        expect(req.prompt).toContain("# specs: widget");
        expect(req.prompt).toContain("# notes: added w.ts");
        await writeFile(join(t, "pr.md"), "# PR: add widget\n");
        return fakeTurn({ summary: "wrote pr body" });
      }
      throw new Error(`unrecognized phase prompt: ${req.prompt.slice(0, 80)}`);
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("the workflow spine end to end", () => {
  it("runs specs -> plan -> build -> pr, leaving all artifacts and approvals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-e2e-"));
    const program = buildProgram({ adapter: phasePlayingAdapter(), presenter: approveAll, writeOut: () => {} });
    program.exitOverride();

    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    await program.parseAsync(["plan", "--cwd", dir], { from: "user" });
    await program.parseAsync(["build", "--cwd", dir], { from: "user" });
    await program.parseAsync(["pr", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();

    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    for (const phase of ["specs", "plan", "build", "pr"]) {
      expect(state.phases[phase].status).toBe("approved");
    }
    expect(await readFile(join(dir, ".tackle", "build.diff"), "utf8")).toBe(BUILD_DIFF);
    expect(await readFile(join(dir, ".tackle", "pr.md"), "utf8")).toContain("# PR: add widget");
    // the authorship record is on every phase (cross-model gate's future input)
    expect(state.phases.build.lastTurn.authorship.adapter).toBe("fake");
  });

  it("resumes across processes: a declined gate is re-presented by the next command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tackle-e2e-"));
    const first = buildProgram({ adapter: phasePlayingAdapter(), presenter: rejectAll, writeOut: () => {} });
    first.exitOverride();
    await first.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBe(1); // declined
    process.exitCode = undefined;

    // "new process": fresh program, approving presenter
    const second = buildProgram({ adapter: phasePlayingAdapter(), presenter: approveAll, writeOut: () => {} });
    second.exitOverride();
    await second.parseAsync(["plan", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();

    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    expect(state.phases.specs.status).toBe("approved"); // gate re-presented and approved
    expect(state.phases.plan.status).toBe("approved");
  });
});
