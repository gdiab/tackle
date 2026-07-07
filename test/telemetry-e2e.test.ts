// test/telemetry-e2e.test.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWorkdirDiff, resolveHead } from "../src/adapter/diff.js";
import type { Adapter, TurnRequest } from "../src/adapter/types.js";
import { buildProgram } from "../src/cli.js";
import { readDecisions } from "../src/decisions/store.js";
import { readTurnRecords } from "../src/telemetry/ledger.js";
import { approveAll, fakeTurn, scriptedAdapter, tempGitRepo } from "./helpers/workflow.js";

const CLEAN = 'done\n\n```json\n{ "verdict": "clean", "findings": [] }\n```\n';
const TOKENS = { inputTokens: 1_000_000, cacheReadInputTokens: 500_000, outputTokens: 200_000, reasoningOutputTokens: 50_000 };

/** Plays each phase by keying on the prompt's "running the <phase> phase" marker (spine-e2e pattern). */
function phasePlayingAdapter(): Adapter {
  return {
    name: "codex",
    run: async (req: TurnRequest) => {
      const t = join(req.workdir, ".tackle");
      await mkdir(t, { recursive: true });
      const usage = { tokens: TOKENS, billingType: "subscription" as const };
      const authorship = { adapter: "codex", model: "gpt-5.1-codex", effort: "medium" as const };
      if (req.prompt.includes("running the specs phase")) {
        await writeFile(join(t, "specs.md"), "# specs: widget\n");
        return fakeTurn({ summary: "wrote specs", usage, authorship });
      }
      if (req.prompt.includes("running the plan phase")) {
        await writeFile(join(t, "plan.md"), "# plan: add w.ts\n");
        return fakeTurn({ summary: "wrote plan", usage, authorship });
      }
      if (req.prompt.includes("running the build phase")) {
        await writeFile(join(t, "build-notes.md"), "# notes\n");
        await writeFile(join(req.workdir, "w.ts"), "export const w = 1;\n");
        const workdirDiff = await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir));
        return fakeTurn({ summary: "built it", workdirDiff, usage, authorship });
      }
      if (req.prompt.includes("running the pr phase")) {
        await writeFile(join(t, "pr.md"), "# PR\n");
        return fakeTurn({ summary: "wrote pr", usage, authorship });
      }
      throw new Error(`unrecognized phase prompt: ${req.prompt.slice(0, 80)}`);
    },
  };
}

function liveCleanReviewer() {
  return scriptedAdapter(
    [
      async (req: TurnRequest) => {
        const workdirDiff = await captureWorkdirDiff(req.workdir, await resolveHead(req.workdir));
        return fakeTurn({
          summary: CLEAN,
          workdirDiff,
          authorship: { adapter: "claude-code", model: null, effort: "medium" },
          usage: { tokens: TOKENS, billingType: "subscription" },
        });
      },
    ],
    "claude-code",
  );
}

describe("telemetry + decisions end to end", () => {
  it("full workflow: per-turn ledger, report over it, and the auto-recorded decision", async () => {
    const dir = await tempGitRepo();
    const out: string[] = [];
    const program = buildProgram({
      adapter: phasePlayingAdapter(),
      reviewerAdapter: liveCleanReviewer(),
      presenter: approveAll,
      writeOut: (s) => out.push(s),
    });
    program.exitOverride();

    await program.parseAsync(["specs", "ship the widget", "--cwd", dir], { from: "user" });
    await program.parseAsync(["plan", "--cwd", dir], { from: "user" });
    await program.parseAsync(["build", "--cwd", dir], { from: "user" });
    await program.parseAsync(["review", "--cwd", dir], { from: "user" });
    await program.parseAsync(["pr", "--cwd", dir], { from: "user" });

    // one ledger line per turn, correct contexts, in order
    const { records, malformed } = await readTurnRecords(dir);
    expect(malformed).toBe(0);
    expect(records.map((r) => r.context)).toEqual([
      "phase:specs",
      "phase:plan",
      "phase:build",
      "review:reviewer",
      "phase:pr",
    ]);
    // the build turn carried real file stats
    const build = records[2];
    expect(build?.filesTouched.map((f) => f.path)).toContain("w.ts");

    // report over the ledger: turns, models, cost, churn all present
    out.length = 0;
    await program.parseAsync(["telemetry", "--cwd", dir, "--json"], { from: "user" });
    const report = JSON.parse(out.join(""));
    expect(report.turns).toBe(5);
    expect(report.byContext["review:reviewer"].turns).toBe(1);
    expect(Object.keys(report.tokens.byModel).sort()).toEqual(["claude-sonnet-4-5", "gpt-5.1-codex"]);
    expect(report.cost.totalUsd).toBeGreaterThan(0);
    expect(report.cost.unpriced).toEqual([]);
    expect(report.billing.subscription.turns).toBe(5);

    // the workflow commit auto-recorded exactly one decision entry
    const decisions = await readDecisions(dir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.title).toBe("ship the widget");
    expect(decisions[0]?.source).toBe("workflow");
    expect(decisions[0]?.decision).toMatch(/committed `[0-9a-f]{10}` after 1 review round\(s\)/);

    // and `tackle decision list` shows it
    out.length = 0;
    await program.parseAsync(["decision", "list", "--cwd", dir], { from: "user" });
    expect(out.join("")).toContain("ship the widget");
  });
});
