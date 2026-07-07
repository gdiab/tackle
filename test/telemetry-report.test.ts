import { describe, expect, it } from "vitest";
import type { TurnRecordV1 } from "../src/telemetry/ledger.js";
import { computeTelemetryReport, renderTelemetryReport } from "../src/telemetry/report.js";

function rec(overrides: Partial<TurnRecordV1>): TurnRecordV1 {
  return {
    schema: "turn-record/v1",
    at: "2026-07-07T10:00:00.000Z",
    context: "turn",
    durationMs: 1000,
    status: "completed",
    billingType: "subscription",
    authorship: { adapter: "codex", model: "gpt-5.1-codex", effort: "medium" },
    tokens: { inputTokens: 1_000_000, cacheReadInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0 },
    filesTouched: [],
    sessionId: null,
    transcriptRef: "/tmp/t.jsonl",
    ...overrides,
  };
}

const RECORDS: TurnRecordV1[] = [
  rec({ context: "phase:build", filesTouched: [{ path: "src/a.ts", insertions: 10, deletions: 2 }] }),
  rec({
    context: "phase:build",
    status: "timeout",
    filesTouched: [
      { path: "src/a.ts", insertions: 5, deletions: 5 },
      { path: "src/b.ts", insertions: 1, deletions: 0 },
    ],
  }),
  rec({ context: "review:reviewer", authorship: { adapter: "claude-code", model: null, effort: "medium" } }),
  rec({ context: "turn", billingType: "metered" }),
  rec({ context: "turn", authorship: { adapter: "codex", model: "wild-new-model", effort: "low" } }),
];

describe("computeTelemetryReport", () => {
  const report = computeTelemetryReport(RECORDS);

  it("counts turns by context and status", () => {
    expect(report.turns).toBe(5);
    expect(report.byContext["phase:build"]).toEqual({ turns: 2, byStatus: { completed: 1, timeout: 1 } });
    expect(report.byContext["turn"]?.turns).toBe(2);
  });

  it("totals tokens and splits by resolved model (null -> adapter default)", () => {
    expect(report.tokens.total.inputTokens).toBe(5_000_000);
    expect(Object.keys(report.tokens.byModel).sort()).toEqual(["claude-sonnet-4-5", "gpt-5.1-codex", "wild-new-model"]);
    expect(report.tokens.byModel["gpt-5.1-codex"]?.inputTokens).toBe(3_000_000);
  });

  it("splits billing and computes the actual-metered cost", () => {
    expect(report.billing["subscription"]?.turns).toBe(4);
    expect(report.billing["metered"]?.turns).toBe(1);
    // one metered gpt-5.1 turn: 1.25 (input) + 1.0 (output)
    expect(report.cost.actualMeteredUsd).toBeCloseTo(2.25, 10);
  });

  it("prices known models and reports unknown models as unpriced, never $0", () => {
    // gpt-5.1-codex: 3 turns = 3.75 + 3.0; claude-sonnet-4-5: 1 turn = 3.0 + 1.5
    expect(report.cost.totalUsd).toBeCloseTo(6.75 + 4.5, 10);
    expect(report.cost.unpriced).toEqual([
      { model: "wild-new-model", tokens: RECORDS[4]?.tokens },
    ]);
  });

  it("aggregates churn per file with touch counts", () => {
    expect(report.churn.files).toEqual([
      { path: "src/a.ts", touches: 2, insertions: 15, deletions: 7 },
      { path: "src/b.ts", touches: 1, insertions: 1, deletions: 0 },
    ]);
    expect(report.churn.multiTouch).toBe(1);
    expect(report.churn.totalFiles).toBe(2);
  });

  it("handles zero records", () => {
    const empty = computeTelemetryReport([]);
    expect(empty.turns).toBe(0);
    expect(empty.cost.totalUsd).toBe(0);
    expect(empty.churn.files).toEqual([]);
  });
});

describe("renderTelemetryReport", () => {
  const report = computeTelemetryReport(RECORDS);

  it("renders all sections, the metered alert, the unpriced line, and the asOf footer", () => {
    const text = renderTelemetryReport(report, { malformed: 2 });
    expect(text).toContain("turns: 5");
    expect(text).toContain("phase:build");
    expect(text).toContain("timeout 1");
    expect(text).toContain("metered");
    expect(text).toContain("UNPRICED wild-new-model");
    expect(text).toContain(report.cost.asOf);
    expect(text).toContain("src/a.ts");
    expect(text).toContain("skipped 2 malformed ledger line(s)");
    expect(text).toContain("actually billed metered");
  });

  it("omits the malformed warning when there is none", () => {
    expect(renderTelemetryReport(report)).not.toContain("malformed");
  });
});
