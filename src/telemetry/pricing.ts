import type { TokenUsage } from "../adapter/types.js";

/** Update rows/values when vendors change pricing; the report footer prints this date. */
export const PRICING_AS_OF = "2026-07-07";

export interface ModelPricing {
  /** Case-insensitive substring of the model name; first match in PRICING order wins. */
  pattern: string;
  inputPerMtok: number;
  cacheReadPerMtok: number;
  outputPerMtok: number;
}

// $ per Mtok. reasoningOutputTokens is a subset of outputTokens in both
// adapters' normalization (claude reports 0), so costUsd uses outputTokens
// alone — reasoning bills at the output rate, matching both vendors.
// Narrow patterns on purpose: a new model must show up as `unpriced`, loudly.
// (A bare "gpt-5" catch-all would silently mis-price future gpt-5-* models —
// e.g. gpt-5-pro is billed far higher than gpt-5.1 — so no such row exists.)
//
// Caveat: the claude adapter does not surface cache-creation input tokens
// (billed at 1.25x the input rate), so claude-turn costUsd is a floor
// estimate until TokenUsage models that field.
export const PRICING: ModelPricing[] = [
  { pattern: "gpt-5.1-codex-mini", inputPerMtok: 0.25, cacheReadPerMtok: 0.025, outputPerMtok: 2 },
  { pattern: "gpt-5.1", inputPerMtok: 1.25, cacheReadPerMtok: 0.125, outputPerMtok: 10 },
  { pattern: "claude-opus-4-5", inputPerMtok: 5, cacheReadPerMtok: 0.5, outputPerMtok: 25 },
  { pattern: "claude-opus-4-1", inputPerMtok: 15, cacheReadPerMtok: 1.5, outputPerMtok: 75 },
  { pattern: "claude-sonnet-4", inputPerMtok: 3, cacheReadPerMtok: 0.3, outputPerMtok: 15 },
  { pattern: "claude-haiku-4", inputPerMtok: 1, cacheReadPerMtok: 0.1, outputPerMtok: 5 },
];

/** authorship.model: null means "backend default"; keys are Adapter.name values. */
export const DEFAULT_MODEL: Record<string, string> = {
  codex: "gpt-5.1-codex",
  "claude-code": "claude-sonnet-4-5",
};

export function resolveModelLabel(authorship: { adapter: string; model: string | null }): string {
  if (authorship.model !== null) return authorship.model;
  return DEFAULT_MODEL[authorship.adapter] ?? `${authorship.adapter} default (unknown model)`;
}

export function findPricing(model: string): ModelPricing | null {
  const needle = model.toLowerCase();
  return PRICING.find((p) => needle.includes(p.pattern)) ?? null;
}

export function costUsd(tokens: TokenUsage, pricing: ModelPricing): number {
  return (
    (tokens.inputTokens * pricing.inputPerMtok +
      tokens.cacheReadInputTokens * pricing.cacheReadPerMtok +
      tokens.outputTokens * pricing.outputPerMtok) /
    1_000_000
  );
}
