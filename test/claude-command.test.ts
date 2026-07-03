import { describe, expect, it } from "vitest";
import { buildPrintCommand } from "../src/adapter/claude/command.js";
import { parseResultJson } from "../src/adapter/claude/result.js";

const okResult = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "looks good",
  session_id: "s-123",
  usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
});

describe("claude print command", () => {
  it("builds a locked-down one-shot invocation with the prompt on stdin", () => {
    const c = buildPrintCommand({ prompt: "review this", effort: "high" });
    expect(c.cmd).toBe("claude");
    expect(c.stdin).toBe("review this");
    expect(c.args).toContain("-p");
    expect(c.args).toContain("--strict-mcp-config");
    const src = c.args.indexOf("--setting-sources");
    expect(c.args[src + 1]).toBe("");
    const eff = c.args.indexOf("--effort");
    expect(c.args[eff + 1]).toBe("high");
    const dis = c.args.indexOf("--disallowedTools");
    for (const tool of ["Bash", "Edit", "Write", "NotebookEdit", "Read", "Glob", "Grep", "Task", "WebFetch", "WebSearch"]) {
      expect(c.args[dis + 1]).toContain(tool);
    }
    expect(c.args).not.toContain("--model");
  });

  it("passes a model override through", () => {
    const c = buildPrintCommand({ prompt: "p", effort: "low", model: "claude-opus-4-8" });
    const m = c.args.indexOf("--model");
    expect(c.args[m + 1]).toBe("claude-opus-4-8");
  });
});

describe("claude result parsing", () => {
  it("maps a success result to a completed turn", () => {
    const r = parseResultJson(okResult);
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("looks good");
    expect(r.sessionId).toBe("s-123");
    expect(r.usage).toEqual({
      inputTokens: 10,
      cacheReadInputTokens: 5,
      outputTokens: 3,
      reasoningOutputTokens: 0,
    });
  });

  it("maps is_error and non-success subtypes to tool_error", () => {
    expect(parseResultJson(okResult.replace('"is_error":false', '"is_error":true')).status).toBe("tool_error");
    expect(parseResultJson(okResult.replace('"success"', '"error_max_turns"')).status).toBe("tool_error");
  });

  it("maps unparseable or wrong-shaped stdout to tool_error with no usage", () => {
    for (const bad of ["", "not json", JSON.stringify({ type: "banana" })]) {
      const r = parseResultJson(bad);
      expect(r.status).toBe("tool_error");
      expect(r.usage).toBeNull();
    }
  });
});
