import { describe, expect, it } from "vitest";
import { buildPrintCommand } from "../src/adapter/codex/command.js";

describe("buildPrintCommand", () => {
  it("builds a fresh exec command with prompt on stdin", () => {
    const cmd = buildPrintCommand({ prompt: "do the thing", effort: "medium" });
    expect(cmd.cmd).toBe("codex");
    expect(cmd.args).toEqual([
      "exec",
      "--json",
      "--full-auto",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="medium"',
      "-",
    ]);
    expect(cmd.stdin).toBe("do the thing");
  });

  it("omits -m unless a model override is given (shipped-default invariant)", () => {
    const bare = buildPrintCommand({ prompt: "p", effort: "low" });
    expect(bare.args).not.toContain("-m");
    const pinned = buildPrintCommand({ prompt: "p", effort: "low", model: "gpt-5.2-codex" });
    expect(pinned.args).toContain("-m");
    expect(pinned.args[pinned.args.indexOf("-m") + 1]).toBe("gpt-5.2-codex");
  });

  it("uses the resume verb when resuming a session", () => {
    const cmd = buildPrintCommand({ prompt: "continue", effort: "high", resumeSessionId: "abc-123" });
    expect(cmd.args.slice(0, 3)).toEqual(["exec", "resume", "abc-123"]);
    expect(cmd.args).toContain("--json");
    expect(cmd.args[cmd.args.length - 1]).toBe("-");
  });
});
