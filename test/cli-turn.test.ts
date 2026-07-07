import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import type { Adapter, TurnResult } from "../src/adapter/types.js";
import { tempWorkdir } from "./helpers/workflow.js";

const fakeResult: TurnResult = {
  status: "completed",
  workdirDiff: "",
  transcriptRef: "/tmp/t.jsonl",
  summary: "done",
  sessionId: "s-1",
  authorship: { adapter: "codex", model: null, effort: "high" },
  usage: {
    tokens: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
    billingType: "subscription",
  },
};

describe("tackle turn", () => {
  it("runs the adapter with parsed options and prints the TurnResult", async () => {
    const dir = await tempWorkdir();
    const run = vi.fn(async () => fakeResult);
    const adapter: Adapter = { name: "codex", run };
    const out: string[] = [];
    const program = buildProgram({ adapter, writeOut: (s) => out.push(s) });
    program.exitOverride();

    await program.parseAsync(
      ["turn", "fix the bug", "--effort", "high", "--timeout", "30", "--cwd", dir],
      { from: "user" },
    );

    expect(run).toHaveBeenCalledWith({
      prompt: "fix the bug",
      workdir: dir,
      effort: "high",
      model: undefined,
      timeoutMs: 30_000,
    });
    expect(JSON.parse(out.join(""))).toEqual(fakeResult);
  });

  it("rejects an invalid effort band", async () => {
    const adapter: Adapter = { name: "codex", run: vi.fn() };
    const program = buildProgram({ adapter, writeOut: () => {} });
    program.exitOverride();
    await expect(
      program.parseAsync(["turn", "p", "--effort", "ultra"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("rejects a non-positive timeout", async () => {
    const run = vi.fn(async () => fakeResult);
    const adapter: Adapter = { name: "codex", run };
    const program = buildProgram({ adapter, writeOut: () => {} });
    program.exitOverride();
    await expect(
      program.parseAsync(["turn", "p", "--timeout", "0"], { from: "user" }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric timeout", async () => {
    const run = vi.fn(async () => fakeResult);
    const adapter: Adapter = { name: "codex", run };
    const program = buildProgram({ adapter, writeOut: () => {} });
    program.exitOverride();
    await expect(
      program.parseAsync(["turn", "p", "--timeout", "soon"], { from: "user" }),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
