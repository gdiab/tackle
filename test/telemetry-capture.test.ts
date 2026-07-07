import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { readTurnRecords } from "../src/telemetry/ledger.js";
import { runPhase } from "../src/workflow/phase.js";
import { runReviewPhase } from "../src/workflow/review.js";
import {
  approveAll,
  fakeTurn,
  scriptedAdapter,
  seedApprovedBuild,
  tempGitRepo,
  tempWorkdir,
  writesArtifact,
} from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';
const FINDINGS =
  'issues\n\n```json\n{ "verdict": "findings", "findings": [{ "severity": "blocking", "file": "w.ts", "summary": "bad" }] }\n```\n';

describe("telemetry capture at the real-turn call sites", () => {
  it("tackle turn records context 'turn' in the --cwd repo", async () => {
    const dir = await tempWorkdir();
    const adapter = scriptedAdapter([async () => fakeTurn()]);
    const program = buildProgram({ adapter, writeOut: () => {} });
    program.exitOverride();
    await program.parseAsync(["turn", "hello", "--cwd", dir], { from: "user" });
    const { records } = await readTurnRecords(dir);
    expect(records.map((r) => r.context)).toEqual(["turn"]);
  });

  it("runPhase records context 'phase:<name>'", async () => {
    const dir = await tempGitRepo();
    const adapter = scriptedAdapter([writesArtifact(".tackle/specs.md", "# specs\n")]);
    const outcome = await runPhase({
      phase: "specs",
      workdir: dir,
      adapter,
      presenter: approveAll,
      canEnter: true,
      request: "do it",
    });
    expect(outcome).toBe("approved");
    const { records } = await readTurnRecords(dir);
    expect(records.map((r) => r.context)).toEqual(["phase:specs"]);
  });

  it("review records 'review:reviewer' and 'review:fix' contexts", async () => {
    const dir = await tempGitRepo();
    const diff = await seedApprovedBuild(dir);
    // round 1: blocking finding; fix turn returns the same tree; round 2: clean
    const reviewer = scriptedAdapter(
      [
        async () => fakeTurn({ summary: FINDINGS, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
        async () => fakeTurn({ summary: CLEAN, workdirDiff: diff, authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
      ],
      "claude-code",
    );
    const author = scriptedAdapter([async () => fakeTurn({ summary: "fixed", workdirDiff: diff })]);
    const outcome = await runReviewPhase({ workdir: dir, reviewer, author, presenter: approveAll });
    expect(outcome).toBe("approved");
    const { records } = await readTurnRecords(dir);
    expect(records.map((r) => r.context)).toEqual(["review:reviewer", "review:fix", "review:reviewer"]);
  });
});
