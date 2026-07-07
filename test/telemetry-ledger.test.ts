import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendTurnRecord, readTurnRecords, TURNS_FILE, type TurnRecordV1 } from "../src/telemetry/ledger.js";
import { tempWorkdir } from "./helpers/workflow.js";

function record(overrides: Partial<TurnRecordV1> = {}): TurnRecordV1 {
  return {
    schema: "turn-record/v1",
    at: "2026-07-07T10:00:00.000Z",
    context: "turn",
    durationMs: 1200,
    status: "completed",
    billingType: "subscription",
    authorship: { adapter: "codex", model: null, effort: "medium" },
    tokens: { inputTokens: 10, cacheReadInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 1 },
    filesTouched: [{ path: "src/a.ts", insertions: 2, deletions: 1 }],
    sessionId: "s-1",
    transcriptRef: "/tmp/t.jsonl",
    ...overrides,
  };
}

describe("turn ledger", () => {
  it("appends one self-contained JSON line per record and reads them back", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, record());
    await appendTurnRecord(dir, record({ context: "phase:build" }));
    const raw = await readFile(join(dir, TURNS_FILE), "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
    const { records, malformed } = await readTurnRecords(dir);
    expect(malformed).toBe(0);
    expect(records.map((r) => r.context)).toEqual(["turn", "phase:build"]);
    expect(records[0]).toEqual(record());
  });

  it("missing ledger reads as empty, not an error", async () => {
    const dir = await tempWorkdir();
    expect(await readTurnRecords(dir)).toEqual({ records: [], malformed: 0 });
  });

  it("skips and counts malformed lines (forgiving reader)", async () => {
    const dir = await tempWorkdir();
    await appendTurnRecord(dir, record());
    await appendFile(join(dir, TURNS_FILE), "not json\n");
    await appendFile(join(dir, TURNS_FILE), JSON.stringify({ schema: "other/v9" }) + "\n");
    await appendFile(join(dir, TURNS_FILE), '"a bare string"\n');
    const { records, malformed } = await readTurnRecords(dir);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(3);
  });

  it("blank lines are ignored, not counted malformed", async () => {
    const dir = await tempWorkdir();
    await mkdir(join(dir, ".tackle/telemetry"), { recursive: true });
    await appendFile(join(dir, TURNS_FILE), "\n\n");
    expect(await readTurnRecords(dir)).toEqual({ records: [], malformed: 0 });
  });
});
