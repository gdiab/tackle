import { describe, expect, it } from "vitest";
import { costUsd, DEFAULT_MODEL, findPricing, PRICING_AS_OF, resolveModelLabel } from "../src/telemetry/pricing.js";

describe("pricing", () => {
  it("matches model names by ordered substring, case-insensitive", () => {
    expect(findPricing("gpt-5.1-codex-max")?.pattern).toBe("gpt-5.1");
    expect(findPricing("GPT-5.1-Codex-Mini")?.pattern).toBe("gpt-5.1-codex-mini");
    expect(findPricing("claude-sonnet-4-5-20250929")?.pattern).toBe("claude-sonnet-4");
  });

  it("unknown models get null, never a silent zero-price row", () => {
    expect(findPricing("wild-new-model-9000")).toBeNull();
  });

  it("resolves a null model to the adapter default, and unknown adapters to a label that prices as unpriced", () => {
    expect(resolveModelLabel({ adapter: "codex", model: null })).toBe(DEFAULT_MODEL["codex"]);
    expect(resolveModelLabel({ adapter: "claude-code", model: null })).toBe(DEFAULT_MODEL["claude-code"]);
    expect(resolveModelLabel({ adapter: "codex", model: "gpt-5.1" })).toBe("gpt-5.1");
    const fallback = resolveModelLabel({ adapter: "someday", model: null });
    expect(fallback).toContain("someday");
    expect(findPricing(fallback)).toBeNull();
  });

  it("adapter defaults resolve to priced rows", () => {
    for (const model of Object.values(DEFAULT_MODEL)) expect(findPricing(model)).not.toBeNull();
  });

  it("costUsd: input + cache-read + output only (reasoning is a subset of output)", () => {
    const p = { pattern: "x", inputPerMtok: 1.25, cacheReadPerMtok: 0.125, outputPerMtok: 10 };
    const tokens = { inputTokens: 1_000_000, cacheReadInputTokens: 2_000_000, outputTokens: 100_000, reasoningOutputTokens: 90_000 };
    expect(costUsd(tokens, p)).toBeCloseTo(1.25 + 0.25 + 1.0, 10);
  });

  it("carries an asOf date for the report footer", () => {
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
