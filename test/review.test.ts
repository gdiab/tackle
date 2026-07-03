// test/review.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapter/types.js";
import { EMPTY_USAGE } from "../src/adapter/types.js";
import { runReviewPhase } from "../src/workflow/review.js";
import { sha256 } from "../src/workflow/hash.js";
import {
  approveAll,
  capturingPresenter,
  fakeTurn,
  rejectAll,
  scriptedAdapter,
  seedApprovedBuild,
  tempGitRepo,
} from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';
const FINDINGS =
  'issues\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "bad" }] }\n```\n';

/** Reviewer fake: echoes the tree's current diff back (a pure, non-writing reviewer). */
function reviewerSaying(summary: string, diff: string) {
  return scriptedAdapter([async () => fakeTurn({ summary, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } })]);
}
const unusedAuthor = () => scriptedAdapter([async () => fakeTurn()]);

async function readState(dir: string) {
  return JSON.parse(await readFile(join(dir, ".tackle", "workflow.json"), "utf8"));
}

describe("runReviewPhase: clean path and commit chain", () => {
  it("clean verdict -> gate -> commit; state records the sha and review.md exists", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const state = await readState(dir);
    expect(state.phases.review.status).toBe("approved");
    expect(state.phases.review.reviewedDiffHash).toBe(sha256(diff));
    expect(state.phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(dir, ".tackle", "review.md"), "utf8")).toContain("clean");
    // the commit actually exists and contains the change, not .tackle
    const { git } = await import("../src/adapter/diff.js");
    const show = await git(dir, ["show", "--stat", "HEAD"]);
    expect(show).toContain("w.ts");
    expect(show).not.toContain(".tackle");
    // tree is clean afterwards
    expect((await git(dir, ["status", "--porcelain"])).trim()).toBe("");
  });

  it("rejecting the gate does not commit", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll,
    });
    expect(outcome).toBe("rejected");
    const { git } = await import("../src/adapter/diff.js");
    expect(await git(dir, ["log", "--oneline"])).not.toContain("add widget");
  });

  it("verifies specs against its pinned hash before reviewing", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir, { specs: "# real specs\n" });
    await writeFile(join(dir, ".tackle", "specs.md"), "# tampered\n");
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("changed after specs was approved");
  });

  it("halts on drift: the tree no longer matches the frozen diff", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await writeFile(join(dir, "w.ts"), "export const w = 2;\n"); // tree drifts
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("changed since build was approved");
  });

  it("halts on a tampered frozen diff (tree and file edited consistently)", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    // consistent rewrite of tree + build.diff that no longer matches the approval pin
    const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
    await writeFile(join(dir, "w.ts"), "export const w = 666;\n");
    const evil = await captureWorkdirDiff(dir, await resolveHead(dir));
    await writeFile(join(dir, ".tackle", "build.diff"), evil);
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, evil), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("does not match the hash pinned at build approval");
  });

  it("fails closed on unknown or same-runtime authorship", async () => {
    for (const authorAdapter of [undefined, "claude-code"]) {
      const dir = await tempGitRepo();
      const diff = await seedApprovedBuild(dir, authorAdapter === undefined ? {} : { authorAdapter });
      if (authorAdapter === undefined) {
        // strip the authorship record to simulate unknown
        const state = await readState(dir);
        delete state.phases.build.lastTurn;
        await writeFile(join(dir, ".tackle", "workflow.json"), JSON.stringify(state));
      }
      const presenter = capturingPresenter(true);
      const reviewer = scriptedAdapter(
        [async () => fakeTurn({ summary: CLEAN, workdirDiff: diff })],
        "claude-code",
      );
      const outcome = await runReviewPhase({ workdir: dir, reviewer, author: unusedAuthor(), presenter });
      expect(outcome).toBe("halted");
    }
  });

  it("halts when the reviewer modifies the working tree", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const impure = scriptedAdapter([
      async (req) => {
        await writeFile(join(req.workdir, "sneaky.ts"), "x\n");
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary: CLEAN, workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      },
    ]);
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: impure, author: unusedAuthor(), presenter });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("reviewer modified the working tree");
  });

  it("halts on non-subscription reviewer billing", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const metered = scriptedAdapter([
      async () => fakeTurn({ summary: CLEAN, workdirDiff: diff, usage: { tokens: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, billingType: "metered" } }),
    ]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: metered, author: unusedAuthor(), presenter: capturingPresenter(true) });
    expect(outcome).toBe("halted");
  });

  it("halts (after retry) on an unparseable verdict", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const babbler = scriptedAdapter([async () => fakeTurn({ summary: "no json here", workdirDiff: diff })]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: babbler, author: unusedAuthor(), presenter: capturingPresenter(true) });
    expect(outcome).toBe("halted");
    expect(babbler.prompts.length).toBe(2); // 1 + deterministicRetries(1)
  });

  it("blocking findings escalate to the gate; approval still commits (integrity, not cleanliness)", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // zero fix-turn budget: escalates straight to the gate off round 1, author untouched
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ reviewLoopIterations: 0 }));
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(FINDINGS, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const state = await readState(dir);
    expect(state.phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(dir, ".tackle", "review.md"), "utf8")).toContain("bad");
  });

  it("resume: a pending review gate is re-presented and commits on approval", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll });
    // second invocation: no new reviewer turn, gate re-presented, commit happens
    const secondReviewer = scriptedAdapter([async () => { throw new Error("must not run a turn on resume"); }]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: secondReviewer, author: unusedAuthor(), presenter: approveAll });
    expect(outcome).toBe("approved");
    expect((await readState(dir)).phases.review.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("never commits .tackle, even in a repo that does not gitignore it", async () => {
    const dir = await tempGitRepo();
    const { git } = await import("../src/adapter/diff.js");
    await git(dir, ["rm", "-q", ".gitignore"]);
    await git(dir, ["commit", "-qm", "drop gitignore"]);
    const diff = await seedApprovedBuild(dir);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const show = await git(dir, ["show", "--stat", "HEAD"]);
    expect(show).toContain("w.ts");
    expect(show).not.toContain(".tackle");
  });

  it("does not run repo hooks when committing (a turn-writable pre-commit hook must not smuggle changes in)", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    const { mkdir, chmod } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\necho x > smuggled.ts\ngit add smuggled.ts\n");
    await chmod(hookPath, 0o755);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const { git } = await import("../src/adapter/diff.js");
    const show = await git(dir, ["show", "--stat", "HEAD"]);
    expect(show).not.toContain("smuggled");
    expect(existsSync(join(dir, "smuggled.ts"))).toBe(false);
  });

  it("refuses to commit when the tree changed between review-pass and approval", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll });
    await writeFile(join(dir, "w.ts"), "export const w = 3;\n"); // tamper post-pass
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: scriptedAdapter([async () => fakeTurn()]), author: unusedAuthor(), presenter });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("refusing to commit");
  });
});

describe("runReviewPhase: fix loop", () => {
  const FINDINGS_A =
    'a\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "issue A" }] }\n```\n';
  const FINDINGS_B =
    'b\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "issue B" }] }\n```\n';

  /** Author fake that "fixes" by changing the tree, returning the new real diff. */
  function fixingAuthor(newContent: string) {
    return scriptedAdapter([
      async (req) => {
        await writeFile(join(req.workdir, "w.ts"), newContent);
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary: "fixed it", workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      },
    ]);
  }

  /** Reviewer that must recompute the live diff per round (post-fix rounds see a new tree). */
  function liveReviewer(summaries: string[]) {
    return scriptedAdapter(
      summaries.map((summary) => async (req: TurnRequest) => {
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary, workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      }),
    );
  }

  it("findings -> fix -> clean -> commit; review.md records both rounds; diff custody updates", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A, CLEAN]);
    const author = fixingAuthor("export const w = 2; // fixed\n");
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: approveAll });
    expect(outcome).toBe("approved");
    const md = await readFile(join(dir, ".tackle", "review.md"), "utf8");
    expect(md).toContain("Round 1");
    expect(md).toContain("Round 2");
    expect(md).toContain("issue A");
    // the committed content is the FIXED version
    const { git } = await import("../src/adapter/diff.js");
    expect(await git(dir, ["show", "HEAD:w.ts"])).toContain("fixed");
    // second reviewer prompt contained the re-frozen diff
    expect(reviewer.prompts[1]).toContain("fixed");
    // custody: build.diffHash matches the final frozen diff
    const state = await readState(dir);
    const frozen = await readFile(join(dir, ".tackle", "build.diff"), "utf8");
    expect(state.phases.build.diffHash).toBe(sha256(frozen));
  });

  it("escalates when the fix budget is exhausted", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    // default reviewLoopIterations = 2: rounds go A, B, A -> the circuit breaker
    // never trips (no two consecutive rounds identical) but 2 fixes are spent -> escalate
    const reviewer = liveReviewer([FINDINGS_A, FINDINGS_B, FINDINGS_A]);
    const author = fixingAuthor("export const w = 2;\n");
    const presenter = capturingPresenter(false); // human rejects the escalation
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter });
    expect(outcome).toBe("rejected");
    expect(reviewer.prompts.length).toBe(3);
    const md = await readFile(join(dir, ".tackle", "review.md"), "utf8");
    expect(md).toContain("Escalated");
  });

  it("circuit-breaks on identical findings two rounds running (no progress)", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A, FINDINGS_A, FINDINGS_A]);
    const author = fixingAuthor("export const w = 9;\n");
    const presenter = capturingPresenter(false);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter });
    expect(outcome).toBe("rejected");
    // identical A twice consecutively trips threshold 2 after ONE fix, not two
    expect(reviewer.prompts.length).toBe(2);
    expect(presenter.messages.concat().join("\n") + (await readFile(join(dir, ".tackle", "review.md"), "utf8"))).toContain("no progress");
  });

  it("halts when a fix turn fails or bills metered", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A]);
    const author = scriptedAdapter([
      async () => fakeTurn({ status: "tool_error", summary: "" }),
      async () => fakeTurn({ status: "tool_error", summary: "" }),
    ]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: capturingPresenter(true) });
    expect(outcome).toBe("halted");
  });

  it("halts when a fix turn bills metered (fail-closed billing gate applies to fix turns too)", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A]);
    const author = scriptedAdapter([async () => fakeTurn({ usage: { tokens: EMPTY_USAGE, billingType: "metered" } })]);
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("billed metered");
  });

  it("halts when a fix turn empties the working tree", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    const reviewer = liveReviewer([FINDINGS_A]);
    // author "fixes" by reverting the seeded change entirely -> empty diff
    const author = scriptedAdapter([
      async (req) => {
        const { rm } = await import("node:fs/promises");
        await rm(join(req.workdir, "w.ts"));
        const { captureWorkdirDiff, resolveHead } = await import("../src/adapter/diff.js");
        return fakeTurn({ summary: "reverted", workdirDiff: await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir)) });
      },
    ]);
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter });
    expect(outcome).toBe("halted");
    expect(presenter.messages.join("\n")).toContain("emptied the working tree");
    expect((await readState(dir)).phases.review.status).toBe("halted");
  });

  it("resumed escalation gate preserves the original detail (gateDetail)", async () => {
    const dir = await tempGitRepo();
    await seedApprovedBuild(dir);
    // identical findings two rounds running trips the circuit breaker after one fix turn
    const reviewer = liveReviewer([FINDINGS_A, FINDINGS_A]);
    const author = fixingAuthor("export const w = 2;\n");
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: capturingPresenter(false) });
    expect(outcome).toBe("rejected");
    const state = await readState(dir);
    expect(state.phases.review.gateDetail).toContain("unresolved blocking");

    let recordedDetail: string | undefined;
    const recordingPresenter = {
      askApproval: async (req: { detail?: string }) => {
        recordedDetail = req.detail;
        return true;
      },
      inform: () => {},
    };
    const throwingReviewer = scriptedAdapter([
      async () => {
        throw new Error("must not run a turn on resume");
      },
    ]);
    const outcome2 = await runReviewPhase({ workdir: dir, reviewer: throwingReviewer, author, presenter: recordingPresenter });
    expect(outcome2).toBe("approved");
    expect(recordedDetail).toContain("unresolved blocking");
  });
});
