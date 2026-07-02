import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeUsage, parseStreamLine } from "../src/adapter/codex/stream.js";

const completedLines = readFileSync("test/fixtures/codex-completed.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.length > 0);

describe("parseStreamLine", () => {
  it("extracts the session id from thread.started", () => {
    expect(parseStreamLine(completedLines[0]!)).toEqual({
      kind: "session",
      sessionId: "019f23af-eb41-7b92-a92e-c4d44bb55af1",
    });
  });

  it("extracts agent message text from item.completed", () => {
    expect(parseStreamLine(completedLines[2]!)).toEqual({ kind: "message", text: "hi" });
  });

  it("extracts normalized usage from turn.completed", () => {
    expect(parseStreamLine(completedLines[3]!)).toEqual({
      kind: "usage",
      usage: {
        inputTokens: 13966 - 5504,
        cacheReadInputTokens: 5504,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
    });
  });

  it("extracts errors from turn.failed", () => {
    const line = readFileSync("test/fixtures/codex-failed.jsonl", "utf8").split("\n")[2]!;
    expect(parseStreamLine(line)).toEqual({
      kind: "error",
      message: "stream error: unexpected status 401",
    });
  });

  it("classifies unknown event types as other", () => {
    expect(parseStreamLine(`{"type":"item.started","item":{}}`)).toEqual({
      kind: "other",
      raw: { type: "item.started", item: {} },
    });
  });

  it("returns null for blank and non-JSON lines (errors arrive on stdout)", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("Reading additional input from stdin...")).toBeNull();
  });
});

describe("normalizeUsage", () => {
  it("splits cached tokens out of input to avoid double counting", () => {
    expect(
      normalizeUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 2 }),
    ).toEqual({ inputTokens: 60, cacheReadInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 2 });
  });

  it("tolerates missing optional fields", () => {
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 1 })).toEqual({
      inputTokens: 10,
      cacheReadInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
    });
  });
});
