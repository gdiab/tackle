// test/review-decisions.test.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDecisions, DECISIONS_FILE } from "../src/decisions/store.js";
import { runReviewPhase } from "../src/workflow/review.js";
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

function reviewerSaying(summary: string, diff: string) {
  return scriptedAdapter([
    async () => fakeTurn({ summary, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
  ]);
}
const unusedAuthor = () => scriptedAdapter([async () => fakeTurn()]);

describe("review-gate decision auto-record", () => {
  it("a clean commit records one workflow-source entry with the sha and round count", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir, { request: "add widget\nwith details" });
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const entries = await readDecisions(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("add widget"); // first line only
    expect(entries[0]?.source).toBe("workflow");
    expect(entries[0]?.decision).toMatch(/committed `[0-9a-f]{10}` after 1 review round\(s\)/);
    expect(entries[0]?.rejected).toEqual([]);
  });

  it("an escalated approval records the knowingly-accepted findings and the rejected alternative", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // zero fix budget: round 1 escalates straight to the gate
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ reviewLoopIterations: 0 }));
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(FINDINGS, diff), author: unusedAuthor(), presenter: approveAll,
    });
    expect(outcome).toBe("approved");
    const entries = await readDecisions(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.decision).toMatch(/despite 1 unresolved blocking finding\(s\): bad/);
    expect(entries[0]?.rejected).toEqual(["reject and discard the review"]);
    expect(entries[0]?.source).toBe("workflow");
  });

  it("a rejected gate records nothing", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter: rejectAll });
    expect(await readDecisions(dir)).toEqual([]);
  });

  it("a resumed escalated gate still records the escalation facts", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    await writeFile(join(dir, ".tackle", "config.json"), JSON.stringify({ reviewLoopIterations: 0 }));
    // first run: human rejects the escalation -> awaiting_approval persists
    await runReviewPhase({ workdir: dir, reviewer: reviewerSaying(FINDINGS, diff), author: unusedAuthor(), presenter: rejectAll });
    // resume: no new reviewer turn; approve commits and records
    const throwingReviewer = scriptedAdapter([async () => { throw new Error("must not run a turn on resume"); }]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer: throwingReviewer, author: unusedAuthor(), presenter: approveAll });
    expect(outcome).toBe("approved");
    const entries = await readDecisions(dir);
    expect(entries[0]?.decision).toMatch(/despite 1 unresolved blocking finding\(s\): bad/);
  });

  it("a decision-write failure warns but the commit stands", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // pre-corrupt decisions.md so appendDecision throws
    await writeFile(join(dir, DECISIONS_FILE), "## broken heading\n");
    const presenter = capturingPresenter(true);
    const outcome = await runReviewPhase({
      workdir: dir, reviewer: reviewerSaying(CLEAN, diff), author: unusedAuthor(), presenter,
    });
    expect(outcome).toBe("approved");
    expect(presenter.messages.join("\n")).toContain("decision entry not recorded");
    // the file was not clobbered and the commit exists
    expect(await readFile(join(dir, DECISIONS_FILE), "utf8")).toBe("## broken heading\n");
    const { git } = await import("../src/adapter/diff.js");
    expect(await git(dir, ["log", "--oneline"])).toContain("add widget");
  });
});
