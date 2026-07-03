import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkdirDiff, git, resolveHead } from "../src/adapter/diff.js";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { approveAll, fakeTurn, rejectAll, scriptedAdapter, tempGitRepo } from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';

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
        await writeFile(join(req.workdir, "w.ts"), "export const w = 1;\n");
        const workdirDiff = await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir));
        return fakeTurn({ summary: "built it", workdirDiff });
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

/** Reviewer fake: recomputes the live diff each round and answers clean, from a different runtime. */
function liveReviewer() {
  return scriptedAdapter(
    [
      async (req: TurnRequest) => {
        const workdirDiff = await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir));
        return fakeTurn({
          summary: CLEAN,
          workdirDiff,
          authorship: { adapter: "claude-fake", model: null, effort: "medium" },
        });
      },
    ],
    "claude-fake",
  );
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("the workflow spine end to end", () => {
  it("runs the full five-phase spine: specs -> plan -> build -> review -> pr", async () => {
    const dir = await tempGitRepo();
    const program = buildProgram({
      adapter: phasePlayingAdapter(),
      reviewerAdapter: liveReviewer(),
      presenter: approveAll,
      writeOut: () => {},
    });
    program.exitOverride();

    await program.parseAsync(["specs", "add a widget", "--cwd", dir], { from: "user" });
    await program.parseAsync(["plan", "--cwd", dir], { from: "user" });
    await program.parseAsync(["build", "--cwd", dir], { from: "user" });
    await program.parseAsync(["review", "--cwd", dir], { from: "user" });
    await program.parseAsync(["pr", "--cwd", dir], { from: "user" });
    expect(process.exitCode).toBeUndefined();

    const state = JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
    for (const phase of ["specs", "plan", "build", "review", "pr"]) {
      expect(state.phases[phase].status).toBe("approved");
    }
    // the authorship record is on every phase (cross-model gate's input)
    expect(state.phases.build.lastTurn.authorship.adapter).toBe("fake");
    expect(state.phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // the review commit is real and holds the change, not .tackle
    const show = await git(dir, ["show", "--stat", state.phases.review.commitSha]);
    expect(show).toContain("w.ts");
    expect(show).not.toContain(".tackle");
    expect(await git(dir, ["log"])).toContain("add a widget");

    // pr ran against the committed tree: build-notes.md was still readable input
    expect(await readFile(join(dir, ".tackle", "pr.md"), "utf8")).toContain("add widget");
  });

  it("resumes across processes: a declined gate is re-presented by the next command", async () => {
    const dir = await tempGitRepo();
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
